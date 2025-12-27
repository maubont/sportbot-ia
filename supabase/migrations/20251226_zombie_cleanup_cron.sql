-- Zombie Order Cleanup Cron Job
-- This schedules the cleanup function to run every hour

-- First, enable pg_cron if not already enabled (requires superuser)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule the cleanup job
-- Note: This uses Supabase's net.http_post to call the Edge Function
-- The cron expression '0 * * * *' means "at minute 0 of every hour"

-- IMPORTANT: Run this in the Supabase SQL Editor with your actual service role key
-- Or configure via Dashboard > Database > Extensions > pg_cron

/*
SELECT cron.schedule(
  'cleanup-zombie-orders',    -- Job name
  '0 * * * *',                -- Every hour at minute 0
  $$
  SELECT net.http_post(
    url := 'https://hjusliaruysnbelkjwol.supabase.co/functions/v1/cleanup_zombie_orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('supabase.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
*/

-- To view scheduled jobs:
-- SELECT * FROM cron.job;

-- To unschedule:
-- SELECT cron.unschedule('cleanup-zombie-orders');

-- ALTERNATIVE: Use Supabase Dashboard
-- Go to: Database > Scheduled Jobs > Create Job
-- Name: cleanup-zombie-orders
-- Schedule: 0 * * * * (every hour)
-- Command: HTTP POST to the Edge Function URL
