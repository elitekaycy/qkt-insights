-- The broker's ticket for an engine order, so deals (which only know broker
-- tickets) can be joined back to the engine orders the UI tables show.
ALTER TABLE orders ADD COLUMN broker_order_id TEXT;

-- Backfill from stored order.accepted / order.filled events, which carry the
-- broker ticket in their payload.
UPDATE orders SET broker_order_id = (
  SELECT json_extract(e.payload, '$.brokerOrderId') FROM events e
  WHERE e.instance_id = orders.instance_id
    AND json_extract(e.payload, '$.orderId') = orders.order_id
    AND json_extract(e.payload, '$.brokerOrderId') IS NOT NULL
  LIMIT 1
);

CREATE INDEX IF NOT EXISTS idx_orders_broker ON orders (instance_id, broker_order_id);
