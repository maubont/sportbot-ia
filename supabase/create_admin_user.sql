-- Enable pgcrypto for password hashing
create extension if not exists "pgcrypto";

-- Create an admin user directly in the auth.users table
-- Email: admin@sportbot.com
-- Password: password123

INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
)
SELECT
    '00000000-0000-0000-0000-000000000000',
    uuid_generate_v4(),
    'authenticated',
    'authenticated',
    'admin@sportbot.com',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now(),
    '',
    '',
    '',
    ''
WHERE NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email = 'admin@sportbot.com'
);

-- Ensure the identity is also created (required for some auth flows)
INSERT INTO auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at
)
SELECT
    uuid_generate_v4(),
    id,
    format('{"sub":"%s","email":"%s"}', id::text, email)::jsonb,
    'email',
    id::text,
    now(),
    now(),
    now()
FROM auth.users
WHERE email = 'admin@sportbot.com'
AND NOT EXISTS (
    SELECT 1 FROM auth.identities WHERE provider = 'email' AND identity_data->>'email' = 'admin@sportbot.com'
);
