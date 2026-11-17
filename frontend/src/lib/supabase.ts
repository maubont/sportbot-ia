import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Database features will not work.');
}

function isPlaceholder(value: string | undefined) {
    return !value || value.includes('YOUR_') || value.includes('_HERE');
}

const isConfigured = supabaseUrl
    && supabaseUrl.startsWith('http')
    && !isPlaceholder(supabaseUrl)
    && !isPlaceholder(supabaseAnonKey)
    && supabaseAnonKey;

export const isSupabaseConfigured = Boolean(isConfigured);

export const supabase = createClient(
    isConfigured ? supabaseUrl : 'https://example.com',
    isConfigured ? supabaseAnonKey : 'placeholder'
);
