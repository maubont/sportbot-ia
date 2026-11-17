/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],

    theme: {
        extend: {
            fontFamily: {
                "display": ["Inter", "sans-serif"],
                "mono": ["JetBrains Mono", "monospace"],
            },
            colors: {
                "primary": "#20d3ee", // Legacy compat
                "canvas": "hsl(var(--canvas))",
                "surface": "hsl(var(--surface))",
                "surface-highlight": "hsl(var(--surface-highlight))",
                "text-primary": "hsl(var(--text-primary))",
                "text-secondary": "hsl(var(--text-secondary))",
                "nike-gray": "#F6F6F6", // Nike Clean Aesthetic

                // Mappings for older code to new system
                "void-dark": "hsl(var(--canvas))",
                "void-light": "hsl(var(--surface))",
                "platinum": "#E2E8F0",
                "muted": "#94A3B8",
            },
            backgroundImage: {
                'electric-mist': 'linear-gradient(to right, #22D3EE, #818CF8)',
                'void-gradient': 'linear-gradient(to bottom, #050507, #0F0F12)',
            },
            boxShadow: {
                'glow': '0 0 40px -10px rgba(34, 211, 238, 0.3)',
                'glow-hover': '0 0 60px -5px rgba(34, 211, 238, 0.5)',
            },
            animation: {
                'float': 'float 4s ease-in-out infinite',
                'float-reverse': 'float 5s ease-in-out infinite reverse',
                'marquee': 'marquee 20s linear infinite',
            },
            keyframes: {
                float: {
                    '0%, 100%': { transform: 'translateY(0)' },
                    '50%': { transform: 'translateY(-10px)' },
                },
                marquee: {
                    '0%': { transform: 'translateX(0)' },
                    '100%': { transform: 'translateX(-50%)' },
                }
            }
        },
    },
    plugins: [],
}
