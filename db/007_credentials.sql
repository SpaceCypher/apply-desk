-- Saved logins: whether the site has accepted the password (verified_at), when it last refused it (rejected_at),
-- and a new password set through "Forgot password" that becomes the saved one once the site accepts it.
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS password_pending_enc TEXT;
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
