import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/utils";
import { Send } from "lucide-react";

type Conversation = {
    id: string;
    customer_id: string;
    last_message_at: string;
    customers: {
        name: string;
        phone_e164: string;
    };
};

type Message = {
    id: string;
    role: "user" | "assistant";
    body: string;
    created_at: string;
};

export default function Chats() {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [selectedConvo, setSelectedConvo] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    useEffect(() => {
        fetchConversations();
    }, []);

    useEffect(() => {
        if (selectedConvo) {
            fetchMessages(selectedConvo);
        }
    }, [selectedConvo]);

    async function fetchConversations() {
        const { data } = await supabase
            .from("conversations")
            .select(`
                *,
                customers (
                    name,
                    phone_e164
                )
            `)
            .order("last_message_at", { ascending: false });
        if (data) setConversations(data as Conversation[]);
    }

    async function fetchMessages(convoId: string) {
        const { data } = await supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", convoId)
            .order("created_at", { ascending: true });
        if (data) setMessages(data as Message[]);
    }

    async function sendMessage() {
        if (!input.trim() || !selectedConvo) return;

        // Optimistic update
        const tempMsg = { id: Date.now().toString(), role: "assistant" as const, body: input, created_at: new Date().toISOString() };
        setMessages([...messages, tempMsg]);
        setInput("");

        // Send to Admin Actions Function (to trigger WhatsApp)
        // For now, just insert to DB if we don't have the function URL configured
        // But ideally we call the function. 
        // Let's toggle between direct DB insert (internal note) vs sending.
        // Assuming "Send" means send to user.

        // We will use direct DB insert for now to simulate, 
        // but in production this should call `admin_actions` edge function.

        await supabase.from("messages").insert({
            conversation_id: selectedConvo,
            role: "assistant",
            direction: "outbound",
            body: tempMsg.body
        });
    }

    return (
        <div className="flex h-[calc(100vh-4rem)] border border-border rounded-lg overflow-hidden">
            {/* Sidebar: Conversation List */}
            <div className="w-1/3 border-r border-border bg-card flex flex-col">
                <div className="p-4 border-b border-border font-semibold">Conversations</div>
                <div className="flex-1 overflow-y-auto">
                    {conversations.map((convo) => (
                        <div
                            key={convo.id}
                            onClick={() => setSelectedConvo(convo.id)}
                            className={cn(
                                "p-4 border-b border-border cursor-pointer hover:bg-accent transition-colors",
                                selectedConvo === convo.id && "bg-accent"
                            )}
                        >
                            <div className="font-medium">{convo.customers?.name || convo.customers?.phone_e164}</div>
                            <div className="text-sm text-muted-foreground truncate">{convo.customers?.phone_e164}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Main: Chat Window */}
            <div className="flex-1 flex flex-col bg-background">
                {selectedConvo ? (
                    <>
                        <div className="flex-1 p-4 overflow-y-auto space-y-4">
                            {messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={cn(
                                        "max-w-[70%] p-3 rounded-lg text-sm",
                                        msg.role === "assistant"
                                            ? "bg-primary text-primary-foreground ml-auto rounded-br-none"
                                            : "bg-muted text-foreground mr-auto rounded-bl-none"
                                    )}
                                >
                                    {msg.body}
                                </div>
                            ))}
                            <div ref={messagesEndRef} />
                        </div>
                        <div className="p-4 border-t border-border flex gap-2">
                            <input
                                className="flex-1 bg-input text-foreground px-4 py-2 rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-ring"
                                placeholder="Type a message..."
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                            />
                            <button
                                onClick={sendMessage}
                                className="p-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                            >
                                <Send className="w-5 h-5" />
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        Select a conversation to start chatting
                    </div>
                )}
            </div>
        </div>
    );
}

