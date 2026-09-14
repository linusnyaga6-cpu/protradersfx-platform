import { Router, type IRouter } from "express";

const router: IRouter = Router();
const DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3";
const PROPOSAL_TIMEOUT_MS = 12_000;
const EXECUTION_TIMEOUT_MS = 30_000;

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
  proposal_open_contract?: {
    contract_id?: string | number;
    is_sold?: number;
    status?: string;
    profit?: number;
    payout?: number;
    buy_price?: number;
    entry_spot?: number | string;
    exit_spot?: number | string;
    entry_tick?: number | string;
    exit_tick?: number | string;
    currency?: string;
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

function requestDerivExecution(input: {
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
  if (!token) throw new Error("Deriv execution credentials are not configured.");

  return new Promise<{ proposal: NonNullable<DerivMessage["proposal"]>; buy: NonNullable<DerivMessage["buy"]>; contract: NonNullable<DerivMessage["proposal_open_contract"]> }>((resolve, reject) => {
    const socket = new WebSocket(`${DERIV_WS_URL}?app_id=${encodeURIComponent(appId)}`);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let proposal: NonNullable<DerivMessage["proposal"]> | undefined;
    let buy: NonNullable<DerivMessage["buy"]> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { socket.close(); } catch {}
      callback();
    };
    const fail = (message: string) => finish(() => reject(new Error(message)));
    timeout = setTimeout(() => fail("Deriv execution did not settle within the allowed time."), EXECUTION_TIMEOUT_MS);
    socket.addEventListener("error", () => fail("Deriv execution connection failed."));
    socket.addEventListener("close", () => { if (!settled) fail("Deriv closed the execution connection."); });
    socket.addEventListener("message", (event) => {
      let message: DerivMessage;
      try { message = JSON.parse(String(event.data)) as DerivMessage; }
      catch { fail("Deriv returned an unreadable execution response."); return; }
      if (message.error) { fail(message.error.message ?? "Deriv rejected the execution request."); return; }
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
        proposal = message.proposal;
        if (!proposal.id || typeof proposal.ask_price !== "number" || !Number.isFinite(proposal.ask_price)) {
          fail("Deriv did not return a purchasable proposal.");
          return;
        }
        socket.send(JSON.stringify({ buy: proposal.id, price: proposal.ask_price }));
        return;
      }
      if (message.msg_type === "buy" && message.buy) {
        buy = message.buy;
        const contractId = buy.contract_id;
        if (!contractId) {
          fail("Deriv did not return a contract ID.");
          return;
        }
        socket.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
        return;
      }
      if (message.msg_type === "proposal_open_contract" && message.proposal_open_contract) {
        const contract = message.proposal_open_contract;
        const isSettled = contract.is_sold === 1 || contract.status === "won" || contract.status === "lost";
        if (isSettled && proposal !== undefined && buy !== undefined) {
          const settledProposal = proposal;
          const settledBuy = buy;
          finish(() => resolve({ proposal: settledProposal, buy: settledBuy, contract }));
        }
      }
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
    const execution = await requestDerivExecution({
      symbol: body.symbol,
      contractType: body.contractType,
      amount: body.amount,
      duration: body.duration,
      durationUnit,
      currency,
      barrier: needsBarrier ? validatedBarrier : undefined,
    });
    const { proposal, buy, contract } = execution;
    const result = contract.status === "won" ? "won" : contract.status === "lost" ? "lost" : "pending";
    res.json({
      execution: "live",
      trade: {
        contractId: buy.contract_id ?? null,
        transactionId: buy.transaction_id ?? null,
        stake: body.amount,
        buyPrice: contract.buy_price ?? buy.buy_price ?? proposal.ask_price ?? null,
        currency: proposal.currency ?? currency,
        result,
        status: contract.status ?? null,
        profit: typeof contract.profit === "number" ? contract.profit : null,
        payout: typeof contract.payout === "number" ? contract.payout : null,
        entrySpot: contract.entry_spot ?? contract.entry_tick ?? null,
        exitSpot: contract.exit_spot ?? contract.exit_tick ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to execute the Deriv contract.";
    res.status(502).json({ error: message });
  }
});

export default router;