-- Allow operators to enable/disable a user-triggered "olvidar" command
-- that resets the bot's per-conversation state mid-flow.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS forget_command_enabled boolean NOT NULL DEFAULT true;
