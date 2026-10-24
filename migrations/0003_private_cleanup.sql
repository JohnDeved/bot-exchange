CREATE INDEX posts_private_expiry ON posts(created_at) WHERE client_key != '';
