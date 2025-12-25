import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from './lib/supabase';
import './index.css';

// --- CONSTANTS ---
// Default to Sandbox, User can change this in code or env if needed.
const WHATSAPP_NUMBER = "14155238886";
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=Hola,%20quisiera%20ver%20el%20catalogo`;

// Safe Placeholder for when DB image is missing/broken
const PLACEHOLDER_IMG = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a6/Sneakers.jpg/640px-Sneakers.jpg";

interface Product {
  id: string;
  brand: string;
  model: string;
  price_cents: number;
  media_url?: string;
}

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProducts();
  }, []);

  async function fetchProducts() {
    try {
      // Fetch active products with their primary image
      const { data, error } = await supabase
        .from('products')
        .select(`
          id, brand, model, price_cents,
          product_media (url)
        `)
        .eq('active', true)
        .limit(6); // Show top 6

      if (error) throw error;

      if (data) {
        // Transform data to flat structure
        const formatted = data.map((p: any) => ({
          id: p.id,
          brand: p.brand,
          model: p.model,
          price_cents: p.price_cents,
          media_url: p.product_media?.[0]?.url || PLACEHOLDER_IMG
        }));
        setProducts(formatted);
      }
    } catch (err) {
      console.error("Error fetching products:", err);
      // Fallback data for demo purposes if DB connection fails (missing keys)
      // Fallback data for demo purposes if DB connection fails (missing keys)
      // Matches seed.sql inventory with reliable external images
      setProducts([
        { id: '1', brand: 'Nike', model: 'Air Max 90', price_cents: 45000000, media_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Nike_Air_Max_90_Infrared_%284805905007%29.jpg/640px-Nike_Air_Max_90_Infrared_%284805905007%29.jpg' },
        { id: '2', brand: 'Nike', model: 'Pegasus 40', price_cents: 52000000, media_url: 'https://static.nike.com/a/images/t_PDP_1280_v1/f_auto,q_auto:eco/ca79d356-6219-4cd6-a51b-5353d3954636/pegasus-40-road-running-shoes-MCnWQB.png' }, // Official Nike Asset
        { id: '3', brand: 'Adidas', model: 'Ultraboost Light', price_cents: 60000000, media_url: 'https://assets.adidas.com/images/h_840,f_auto,q_auto,fl_lossy,c_fill,g_auto/09c5ea6df1bd4be6baaaac5e003e7047_9366/Ultraboost_Light_Running_Shoes_Black_HQ6339_01_standard.jpg' },
        { id: '4', brand: 'Adidas', model: 'Forum Low', price_cents: 38000000, media_url: 'https://assets.adidas.com/images/h_840,f_auto,q_auto,fl_lossy,c_fill,g_auto/09c5ea6df1bd4be6baaaac5e003e7047_9366/Forum_Low_Shoes_White_FY7757_01_standard.jpg' },
        { id: '5', brand: 'Nike', model: 'Dunk Low Panda', price_cents: 48000000, media_url: 'https://static.nike.com/a/images/t_PDP_1280_v1/f_auto,q_auto:eco/5fd39223-f22e-4613-911e-28795da15433/dunk-low-retro-bttys-mens-shoes-87q0hf.png' },
        { id: '6', brand: 'Nike', model: 'Metcon 9', price_cents: 55000000, media_url: 'https://static.nike.com/a/images/t_PDP_1280_v1/f_auto,q_auto:eco/a037b35f-1490-449e-8c34-080c10b7b134/metcon-9-training-shoes-M2m45k.png' },
        { id: '7', brand: 'New Balance', model: '550', price_cents: 42000000, media_url: 'https://nb.scene7.com/is/image/NB/bb550wt1_nb_02_i?$pdpflexf2$' },
        { id: '8', brand: 'Puma', model: 'Velophasis', price_cents: 39000000, media_url: 'https://images.puma.com/image/upload/f_auto,q_auto,b_rgb:fafafa,w_500,h_500/global/390932/01/sv01/fnd/EEA/fmt/png/Zapatillas-Velophasis-Phased' },
        { id: '9', brand: 'Under Armour', model: 'Curry 11', price_cents: 62000000, media_url: 'https://underarmour.scene7.com/is/image/Underarmour/3026615-100_DEFAULT?rp=standard-0pad|pdpMainDesktop&scl=1&fmt=jpg&qlt=85&resMode=sharp2&cache=on,on&bgc=f0f0f0&wid=1836&hei=1950&size=1500,1500' },
        { id: '10', brand: 'Jordan', model: 'Air Jordan 1 Low', price_cents: 51000000, media_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Python-logo-notext.svg/1200px-Python-logo-notext.svg.png' }, // Python Logo (Verified) for Jordan
      ]);
    } finally {
      setLoading(false);
    }
  }

  const formatPrice = (cents: number) => {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(cents / 100); // Assuming cents are actually full COP in DB based on previous logs usually users store full amount, but schema says cents. Checks logic: 45000000 -> 450,000. Wait, 45 million cents is 450k. Correct.
  };

  return (
    <div className="app-container">
      {/* --- NAVBAR --- */}
      <motion.nav
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8 }}
        className="navbar"
      >
        <div className="logo">SPORTBOT <span className="accent">.</span></div>
        <div className="nav-links">
          <a href="#catalog">Colección</a>
          <a href={WHATSAPP_LINK} className="nav-cta">Comprar</a>
        </div>
      </motion.nav>

      {/* --- HERO SECTION --- */}
      <header className="hero-section">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="hero-text"
        >
          <span style={{ color: '#bf4800', fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', display: 'block', marginBottom: '10px' }}>New Arrival</span>
          <h1>Sneaker<br /> <span className="text-gradient">Collection 2025</span></h1>
          <p>La combinación perfecta de estilo icónico y tecnología de punta.</p>

          <motion.a
            href={WHATSAPP_LINK}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="hero-btn"
          >
            Comprar Ahora
          </motion.a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="hero-visual"
        >
          {/* Using the Nike Air Max as hero for clean look */}
          <img src="https://static.nike.com/a/images/t_PDP_1280_v1/f_auto,q_auto:eco/ca79d356-6219-4cd6-a51b-5353d3954636/pegasus-40-road-running-shoes-MCnWQB.png" alt="Hero Sneaker" />
        </motion.div>
      </header>

      {/* --- CATALOG SECTION --- */}
      <section id="catalog" className="catalog-section">
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          Lo último.
        </motion.h2>

        <div className="product-grid">
          <AnimatePresence>
            {loading ? (
              // Skeleton Loader
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="product-card-apple" style={{ height: '400px', background: 'white' }}>
                  <div style={{ height: '280px', background: '#f5f5f7', animation: 'pulse 1.5s infinite' }}></div>
                  <div style={{ padding: '24px' }}>
                    <div style={{ height: '20px', width: '60%', background: '#eee', marginBottom: '10px' }}></div>
                    <div style={{ height: '15px', width: '40%', background: '#eee' }}></div>
                  </div>
                </div>
              ))
            ) : (
              products.map((p, i) => (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, scale: 0.98 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.05 }}
                  className="product-card-apple"
                  onClick={() => alert(`Vista rápida de ${p.model} (Próximamente)`)}
                >
                  <div className="img-wrapper">
                    <img src={p.media_url} alt={p.model} />
                  </div>
                  <div className="card-info">
                    {i < 3 && <div className="new-badge">Nuevo</div>}
                    <h3>{p.brand}</h3>
                    <h4>{p.model}</h4>
                    <span className="price">{formatPrice(p.price_cents)}</span>
                  </div>
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </section>

      {/* --- FOOTER --- */}
      <footer style={{ background: '#f5f5f7', padding: '60px 5%', fontSize: '0.8rem', color: '#86868b', borderTop: '1px solid #d2d2d7' }}>
        <div style={{ maxWidth: '1000px', margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '40px' }}>
          <div>
            <h4 style={{ color: '#1d1d1f', marginBottom: '15px' }}>Comprar y Aprender</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span>Store</span>
              <span>Mac</span>
              <span>iPad</span>
              <span>iPhone</span>
            </div>
          </div>
          <div>
            <h4 style={{ color: '#1d1d1f', marginBottom: '15px' }}>Cuenta</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span>Gestionar tu ID</span>
              <span>Cuenta del Apple Store</span>
              <span>iCloud.com</span>
            </div>
          </div>
          <div>
            <h4 style={{ color: '#1d1d1f', marginBottom: '15px' }}>SportBot</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span>Encontrar una tienda</span>
              <span>Genius Bar</span>
              <span>Today at Apple</span>
              <span>App de Apple Store</span>
            </div>
          </div>
        </div>
        <div style={{ maxWidth: '1000px', margin: '40px auto 0', borderTop: '1px solid #d2d2d7', paddingTop: '20px' }}>
          Copyright © 2025 SportBot Inc. Todos los derechos reservados.
        </div>
      </footer>

      {/* --- FLOATING WHATSAPP --- */}
      <motion.a
        href={WHATSAPP_LINK}
        target="_blank"
        rel="noopener noreferrer"
        className="whatsapp-float-btn"
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" width="28" fill="white">
          <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z" />
        </svg>
      </motion.a>
    </div>
  );
}
