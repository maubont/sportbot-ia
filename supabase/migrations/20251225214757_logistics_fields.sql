-- Migration: Add Logistics Columns
-- Date: 2025-12-25
-- Description: Adds tracking_number, carrier_name, and shipped_at to orders table.

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS tracking_number TEXT,
ADD COLUMN IF NOT EXISTS carrier_name TEXT,
ADD COLUMN IF NOT EXISTS shipped_at TIMESTamptZ;

-- Add comment/status update logic if needed
-- We assume status can be 'shipped' as it is a TEXT column without strict ENUM constraint in the inspected schema.
-- If there was a constraint, we would drop and recreate it, but inspection showed standard text.
