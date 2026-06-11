import { useQuery } from "@tanstack/react-query";
import { get, type ClosedTradeRow, type EquityPoint, type OrderRow, type TradeRow } from "../api";
import { duration, human, money, ts } from "../format";
import { Delta, Field, Modal, Pill, SideTag, STATE_TONE } from "./ui";

/** Realized dollar result of the close matching this order, with the win/loss verdict. */
function OutcomeFields({ close }: { close: ClosedTradeRow | null | undefined }) {
  return (
    <Field label="Realized P&L" wide>
      {close ? (
        <span className="flex items-center gap-2.5">
          <span className={close.realized > 0 ? "text-up" : close.realized < 0 ? "text-down" : "text-muted"}>
            {close.realized > 0 ? "+" : ""}
            {money(close.realized)}
          </span>
          <Pill tone={close.realized > 0 ? "up" : close.realized < 0 ? "down" : "neutral"}>
            {close.realized > 0 ? "WIN" : close.realized < 0 ? "LOSS" : "FLAT"}
          </Pill>
          {close.entryTs != null && <span className="text-xs text-faint">held {duration(close.ts - close.entryTs)}</span>}
        </span>
      ) : (
        <span className="text-faint">— position not closed yet, or this qkt version doesn't report trade.closed</span>
      )}
    </Field>
  );
}

/*
 * Row-level drill-down modals: everything about one trade or one order that
 * doesn't fit in a table row, including the strategy's equity just before and
 * just after the moment it happened.
 */

function useEquityAround(instanceId: string, strategyId: string | null, at: number) {
  const equity = useQuery({
    queryKey: ["equity", instanceId, strategyId],
    queryFn: () =>
      get<EquityPoint[]>(
        `/equity?instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId!)}`,
      ),
    enabled: !!strategyId,
  });
  const pts = equity.data ?? [];
  let before: EquityPoint | null = null;
  let after: EquityPoint | null = null;
  for (const p of pts) {
    if (p.ts <= at) before = p;
    if (p.ts > at && !after) after = p;
  }
  return { before, after };
}

function EquityFields({ instanceId, strategyId, at }: { instanceId: string; strategyId: string | null; at: number }) {
  const { before, after } = useEquityAround(instanceId, strategyId, at);
  const change = before && after ? (after.equity - before.equity) / before.equity : null;
  return (
    <>
      <Field label="Equity before">
        {before ? `${money(before.equity)}` : "—"}
        {before && <span className="ml-2 text-xs text-faint">at {ts(before.ts).slice(11)}</span>}
      </Field>
      <Field label="Equity after">
        {after ? `${money(after.equity)}` : "—"}
        {after && <span className="ml-2 text-xs text-faint">at {ts(after.ts).slice(11)}</span>}
      </Field>
      <Field label="Equity move across it" wide>
        <Delta value={change} />
      </Field>
    </>
  );
}

export function TradeDetail({
  trade,
  instanceId,
  onClose,
  close,
}: {
  trade: TradeRow | null;
  instanceId: string;
  onClose: () => void;
  close?: ClosedTradeRow | null;
}) {
  if (!trade) return null;
  const p = trade.payload;
  return (
    <Modal open onClose={onClose} title="Trade" hint={trade.id} width="min(94vw, 720px)">
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5">
        <Field label="Executed" wide>
          {human(trade.ts)}
        </Field>
        <OutcomeFields close={close} />
        <Field label="Symbol">{p.symbol}</Field>
        <Field label="Side">
          <SideTag side={p.side} />
        </Field>
        <Field label="Quantity">{p.qty}</Field>
        <Field label="Price">{p.price}</Field>
        <Field label="Notional (qty × price)">{money(p.qty * p.price)}</Field>
        <Field label="Strategy">{trade.strategyId ?? "—"}</Field>
        <EquityFields instanceId={instanceId} strategyId={trade.strategyId} at={trade.ts} />
        <Field label="Order id">{p.orderId}</Field>
        <Field label="Instance">{instanceId}</Field>
      </div>
    </Modal>
  );
}

export function OrderDetail({
  order,
  instanceId,
  onClose,
  close,
}: {
  order: OrderRow | null;
  instanceId: string;
  onClose: () => void;
  close?: ClosedTradeRow | null;
}) {
  if (!order) return null;
  const notional = order.avgPrice != null ? (order.qty ?? order.cumQty) * order.avgPrice : null;
  return (
    <Modal open onClose={onClose} title="Order" hint={order.orderId} width="min(94vw, 720px)">
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5">
        <OutcomeFields close={close} />
        <Field label="Submitted">{human(order.createdTs)}</Field>
        <Field label="Last update">{human(order.updatedTs)}</Field>
        <Field label="Lifetime">{duration(order.updatedTs - order.createdTs)}</Field>
        <Field label="State">
          <Pill tone={STATE_TONE[order.state] ?? "neutral"}>{order.state}</Pill>
        </Field>
        <Field label="Symbol">{order.symbol ?? "—"}</Field>
        <Field label="Side">
          <SideTag side={order.side} />
        </Field>
        <Field label="Type">{order.type ?? "—"}</Field>
        <Field label="Quantity">
          {order.qty ?? "—"}
          <span className="ml-2 text-xs text-faint">{order.cumQty} filled</span>
        </Field>
        <Field label="Avg fill price">{order.avgPrice ?? "—"}</Field>
        <Field label="Notional (qty × avg px)">{notional != null ? money(notional) : "—"}</Field>
        <Field label="Strategy">{order.strategyId ?? "—"}</Field>
        <EquityFields instanceId={instanceId} strategyId={order.strategyId} at={order.updatedTs} />
        <Field label="Instance">{instanceId}</Field>
      </div>
    </Modal>
  );
}
