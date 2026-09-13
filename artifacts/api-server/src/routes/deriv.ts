import { Router, type IRouter } from "express";

const router: IRouter = Router();
const DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3";
const PROPOSAL_TIMEOUT_MS = 12_000;

type ProposalRequest = {
  symbol?: unknown;
  contractType?: unknown;
  amount?: unknown;
  duration?: unknown;
  durationUnit?: unknown;
  currency?: unknown;
  barrier?: unknown;
};

type DerivMessage = {
  msg_type?: string;
  error?: { code?: string; message?: string };
  proposal?: {
    id?: string;
    ask_price?: number;
    payout?: number;
    spot?: number;
    longcode?: string;
    display_value?: string;
    currency?: string;
  };
  buy?: {
    contract_id?: string | number;
    transaction_id?: string | number;
    buy_price?: number;
  };
};

function isValidSymbol(value: unknown): value is string {
  return typeof value === "string" && /^(1HZ\d+V|R_\d+|frx[A-Z]{6})$/.test(value);
}

function isValidContractType(value: unknown): value is "CALL" | "PUT" | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD" {
  return value === "CALL" || value === "PUT" || value === "DIGITOVER" || value === "DIGITUNDER" || value === "DIGITEVEN" || value === "DIGITODD";
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function requestDerivProposal(input: {
  symbol: string;
  contractType: "CALL" | "PUT" | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD";
  amount: number;
  duration: number;
  durationUnit: string;
  currency: string;
  barrier?: number;
}) {
  const token = process.env["DERIV_API_TOKEN"];
  const configuredAppId = process.env["DERIV_APP_ID"] ?? "";
  const appId = /^\d+$/.test(configuredAppId) ? configuredAppId : "1089";
  if (!token) {
    throw new Error("Deriv proposal credentials are not configured.");
  }

  return new Promise<NonNullable<DerivMessage["proposal"]>>((resolve, reject) => {
    const socket = new WebSocket(`${DERIV_WS_URL}?app_id=${encodeURIComponent(appId)}`);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        // The socket may already be closed by Deriv.
      }
      callback();
    };

    const fail = (message: string) => finish(() => reject(new Error(message)));

    timeout = setTimeout(() => fail("Deriv proposal request timed out."), PROPOSAL_TIMEOUT_MS);
    socket.addEventListener("error", () => fail("Deriv proposal connection failed."));
    socket.addEventListener("close", () => {
      if (!settled) fail("Deriv closed the proposal connection.");
    });
    socket.addEventListener("message", (event) => {
      let message: DerivMessage;
      try {
        message = JSON.parse(String(event.data)) as DerivMessage;
      } catch {
        fail("Deriv returned an unreadable proposal response.");
        return;
      }

      if (message.error) {
        fail(message.error.message ?? "Deriv rejected the proposal request.");
        return;
      }

      if (message.msg_type === "authorize") {
        const proposalPayload: Record<string, string | number> = {
          proposal: 1,
          amount: input.amount,
          basis: "stake",
          contract_type: input.contractType,
          currency: input.currency,
          duration: input.duration,
          duration_unit: input.durationUnit,
          symbol: input.symbol,
        };
        if (input.barrier !== undefined) proposalPayload.barrier = input.barrier;
        socket.send(JSON.stringify(proposalPayload));
        return;
      }

      if (message.msg_type === "proposal" && message.proposal) {
        finish(() => resolve(message.proposal!));
      }
    });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ authorize: token }));
    });
  });
}

function requestDerivBuy(input: { proposalId: string; price: number }) {
  const token = process.env["DERIV_API_TOKEN"];
  const configuredAppId = process.env["DERIV_APP_ID"] ?? "";
  const appId = /^\d+$/.test(configuredAppId) ? configuredAppId : "1089";
  if (!token) throw new Error("Deriv execution credentials are not configured.");

  return new Promise<DerivMessage>((resolve, reject) => {
    const socket = new WebSocket(`${DERIV_WS_URL}?app_id=${encodeURIComponent(appId)}`);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { socket.close(); } catch {}
      callback();
    };
    const fail = (message: string) => finish(() => reject(new Error(message)));
    timeout = setTimeout(() => fail("Deriv execution request timed out."), PROPOSAL_TIMEOUT_MS);
    socket.addEventListener("error", () => fail("Deriv execution connection failed."));
    socket.addEventListener("close", () => { if (!settled) fail("Deriv closed the execution connection."); });
    socket.addEventListener("message", (event) => {
      let message: DerivMessage;
      try { message = JSON.parse(String(event.data)) as DerivMessage; }
      catch { fail("Deriv returned an unreadable execution response."); return; }
      if (message.error) { fail(message.error.message ?? "Deriv rejected the execution request."); return; }
      if (message.msg_type === "authorize") {
        socket.send(JSON.stringify({ buy: input.proposalId, price: input.price }));
        return;
      }
      if (message.msg_type === "buy") finish(() => resolve(message));
    });
    socket.addEventListener("open", () => socket.send(JSON.stringify({ authorize: token })));
  });
}

router.post("/deriv/proposal", async (req, res) => {
  const body = (req.body ?? {}) as ProposalRequest;
  if (!isValidSymbol(body.symbol) || !isValidContractType(body.contractType)) {
    res.status(400).json({ error: "A valid Deriv symbol and contract type are required." });
    return;
  }
  if (!numberInRange(body.amount, 0.35, 10_000) || !numberInRange(body.duration, 1, 365)) {
    res.status(400).json({ error: "Amount or duration is outside the supported range." });
    return;
  }
  const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : "USD";
  const durationUnit = body.durationUnit === "t" || body.durationUnit === "s" || body.durationUnit === "m" ? body.durationUnit : "t";
  const needsBarrier = body.contractType === "DIGITOVER" || body.contractType === "DIGITUNDER";
  const validatedBarrier = numberInRange(body.barrier, 0, 9) ? body.barrier : undefined;
  if (needsBarrier && validatedBarrier === undefined) {
    res.status(400).json({ error: "A digit barrier from 0 to 9 is required for this contract." });
    return;
  }

  try {
    const proposal = await requestDerivProposal({
      symbol: body.symbol,
      contractType: body.contractType,
      amount: body.amount,
      duration: body.duration,
      durationUnit,
      currency,
      barrier: needsBarrier ? validatedBarrier : undefined,
    });
    res.json({
      proposal: {
        id: proposal.id ?? null,
        askPrice: proposal.ask_price ?? null,
        payout: proposal.payout ?? null,
        spot: proposal.spot ?? null,
        displayValue: proposal.display_value ?? null,
        longcode: proposal.longcode ?? null,
        currency: proposal.currency ?? currency,
      },
      execution: "proposal-only",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to request a Deriv proposal.";
    res.status(502).json({ error: message });
  }
});

router.post("/deriv/execute", async (req, res) => {
  const body = (req.body ?? {}) as ProposalRequest & { confirm?: unknown };
  if (body.confirm !== true) {
    res.status(400).json({ error: "Explicit execution confirmation is required." });
    return;
  }
  if (!isValidSymbol(body.symbol) || !isValidContractType(body.contractType)) {
    res.status(400).json({ error: "A valid Deriv symbol and contract type are required." });
    return;
  }
  if (!numberInRange(body.amount, 0.35, 10_000) || !numberInRange(body.duration, 1, 365)) {
    res.status(400).json({ error: "Amount or duration is outside the supported range." });
    return;
  }
  const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : "USD";
  const durationUnit = body.durationUnit === "t" || body.durationUnit === "s" || body.durationUnit === "m" ? body.durationUnit : "t";
  const needsBarrier = body.contractType === "DIGITOVER" || body.contractType === "DIGITUNDER";
  const validatedBarrier = numberInRange(body.barrier, 0, 9) ? body.barrier : undefined;
  if (needsBarrier && validatedBarrier === undefined) {
    res.status(400).json({ error: "A digit barrier from 0 to 9 is required for this contract." });
    return;
  }

  try {
    const proposal = await requestDerivProposal({
      symbol: body.symbol,
      contractType: body.contractType,
      amount: body.amount,
      duration: body.duration,
      durationUnit,
      currency,
      barrier: needsBarrier ? validatedBarrier : undefined,
    });
    const price = proposal.ask_price;
    if (!proposal.id || typeof price !== "number" || !Number.isFinite(price)) throw new Error("Deriv did not return a purchasable proposal.");
    const trade = await requestDerivBuy({ proposalId: proposal.id, price });
    res.json({
      execution: "live",
      trade: {
        contractId: trade.buy?.contract_id ?? null,
        transactionId: trade.buy?.transaction_id ?? null,
        buyPrice: trade.buy?.buy_price ?? price,
        currency: proposal.currency ?? currency,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to execute the Deriv contract.";
    res.status(502).json({ error: message });
  }
});

export default router;