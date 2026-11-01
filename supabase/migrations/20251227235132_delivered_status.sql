-- Add delivered_at column to orders table
-- This completes the order lifecycle: draft → awaiting_payment → paid → shipped → delivered

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Add comment for documentation
COMMENT ON COLUMN orders.delivered_at IS 'Timestamp when the order was marked as delivered to the customer';
