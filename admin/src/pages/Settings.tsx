import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Save } from "lucide-react";

export default function Settings() {
    const [systemPrompt, setSystemPrompt] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        fetchSettings();
    }, []);

    async function fetchSettings() {
        const { data } = await supabase
            .from("settings")
            .select("value")
            .eq("key", "system_prompt")
            .single();

        if (data) {
            setSystemPrompt(data.value as string);
        }
    }

    async function saveSettings() {
        setLoading(true);
        await supabase.from("settings").upsert({
            key: 'system_prompt',
            value: systemPrompt,
            updated_at: new Date().toISOString()
        });
        setLoading(false);
    }

    return (
        <div className="space-y-6 max-w-2xl">
            <div className="flex justify-between items-center">
                <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
            </div>

            <div className="space-y-4">
                <div className="space-y-2">
                    <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                        System Prompt (AI Persona)
                    </label>
                    <textarea
                        className="flex min-h-[150px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        placeholder="You are a helpful assistant..."
                    />
                    <p className="text-sm text-muted-foreground">
                        This prompt defines how the AI agent behaves on WhatsApp.
                    </p>
                </div>

                <button
                    onClick={saveSettings}
                    disabled={loading}
                    className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 disabled:opacity-50"
                >
                    <Save className="w-4 h-4" />
                    {loading ? "Saving..." : "Save Changes"}
                </button>
            </div>
        </div>
    );
}
