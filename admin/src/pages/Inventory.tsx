import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
    Plus,
    Search,
    ChevronDown,
    ChevronUp,
    AlertTriangle,
    Package
} from "lucide-react";

type Product = {
    id: string;
    sku: string;
    brand: string;
    model: string;
    category: string;
    price_cents: number;
    active: boolean;
    product_variants: Variant[];
};

type Variant = {
    id: string;
    size: number;
    stock: number;
};

export default function Inventory() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
    const [committedStock, setCommittedStock] = useState<Record<string, number>>({});
    const [searchTerm, setSearchTerm] = useState("");

    useEffect(() => {
        fetchInventoryData();
    }, []);

    async function fetchInventoryData() {
        setLoading(true);
        try {
            // 1. Fetch Products & Variants
            const { data: productsData, error: prodError } = await supabase
                .from("products")
                .select(`
                    *,
                    product_variants (id, size, stock)
                `)
                .order("created_at", { ascending: false });

            if (prodError) throw prodError;

            // 2. Fetch Committed Stock (Items in 'paid' orders that are not shipped yet)
            // Note: In a real large-scale app, this should be a DB View or specialized query.
            const { data: activeOrders, error: ordError } = await supabase
                .from("orders")
                .select(`
                    id, 
                    status,
                    order_items ( variant_id, qty )
                `)
                .in('status', ['paid', 'processing']); // Only count paid stock as committed

            if (ordError) throw ordError;

            // Aggregate committed stock by Variant ID
            const committedMap: Record<string, number> = {};
            activeOrders?.forEach(order => {
                order.order_items.forEach((item: any) => {
                    committedMap[item.variant_id] = (committedMap[item.variant_id] || 0) + item.qty;
                });
            });

            setProducts(productsData || []);
            setCommittedStock(committedMap);

        } catch (err) {
            console.error("Error fetching inventory:", err);
        } finally {
            setLoading(false);
        }
    }

    const toggleRow = (id: string) => {
        const newSet = new Set(expandedRows);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setExpandedRows(newSet);
    };

    const formatCurrency = (cents: number) =>
        new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(cents / 100);

    const filteredProducts = products.filter(p =>
        p.model.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.brand.toLowerCase().includes(searchTerm.toLowerCase())
    );

    // Calculate Totals for Header
    const totalValue = products.reduce((acc, p) => {
        const stock = p.product_variants.reduce((s, v) => s + v.stock, 0);
        return acc + (stock * p.price_cents);
    }, 0);

    const totalUnits = products.reduce((acc, p) => acc + p.product_variants.reduce((s, v) => s + v.stock, 0), 0);

    const [showNewProductModal, setShowNewProductModal] = useState(false);

    // Form State
    const [newProduct, setNewProduct] = useState({
        brand: '',
        model: '',
        sku: '',
        category: 'casual',
        price_cents: 0,
        initial_variants: [{ size: '', stock: '' }] as { size: string, stock: string }[]
    });

    const [addingVariantTo, setAddingVariantTo] = useState<string | null>(null);
    const [newVariant, setNewVariant] = useState({ size: '', stock: '' });

    async function handleCreateProduct(e: React.FormEvent) {
        e.preventDefault();
        setLoading(true);
        try {
            // 1. Create Product
            const { data: prodData, error: prodError } = await supabase.from('products').insert({
                brand: newProduct.brand,
                model: newProduct.model,
                sku: newProduct.sku,
                category: newProduct.category,
                price_cents: newProduct.price_cents * 100, // Convert to cents
                active: true
            }).select().single();

            if (prodError) throw prodError;

            // 2. Create Initial Variants
            const variantsToInsert = newProduct.initial_variants
                .filter(v => v.size && v.stock)
                .map(v => ({
                    product_id: prodData.id,
                    size: Number(v.size),
                    stock: Number(v.stock)
                }));

            if (variantsToInsert.length > 0) {
                const { error: varError } = await supabase.from('product_variants').insert(variantsToInsert);
                if (varError) console.error("Error creating variants:", varError);
            }

            // Reset and Refresh
            setShowNewProductModal(false);
            setNewProduct({
                brand: '', model: '', sku: '', category: 'casual', price_cents: 0,
                initial_variants: [{ size: '', stock: '' }]
            });
            await fetchInventoryData();

        } catch (error: any) {
            console.error("Error creating product:", error);
            alert(`Error al crear producto: ${error.message || error.details}`);
        } finally {
            setLoading(false);
        }
    }

    async function handleAddVariant(productId: string) {
        if (!newVariant.size || !newVariant.stock) return;
        setLoading(true);
        try {
            const { error } = await supabase.from('product_variants').insert({
                product_id: productId,
                size: Number(newVariant.size),
                stock: Number(newVariant.stock)
            });

            if (error) throw error;

            setNewVariant({ size: '', stock: '' });
            setAddingVariantTo(null);
            await fetchInventoryData();
        } catch (error: any) {
            console.error("Error adding variant:", error);
            alert(`Error al agregar talla: ${error.message}`);
        } finally {
            setLoading(false);
        }
    }

    const addVariantRow = () => {
        setNewProduct({
            ...newProduct,
            initial_variants: [...newProduct.initial_variants, { size: '', stock: '' }]
        });
    };

    const removeVariantRow = (index: number) => {
        const rows = [...newProduct.initial_variants];
        rows.splice(index, 1);
        setNewProduct({ ...newProduct, initial_variants: rows });
    };

    const updateVariantRow = (index: number, field: 'size' | 'stock', value: string) => {
        const rows = [...newProduct.initial_variants];
        rows[index] = { ...rows[index], [field]: value };
        setNewProduct({ ...newProduct, initial_variants: rows });
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Gestión de Inventario</h2>
                    <p className="text-muted-foreground">Vista detallada de stock físico y comprometido.</p>
                </div>
                <div className="flex gap-2">
                    <div className="bg-card text-card-foreground border rounded-lg px-4 py-2 text-sm">
                        <span className="text-muted-foreground block text-xs">Valor Total (PVP)</span>
                        <span className="font-bold">{formatCurrency(totalValue)}</span>
                    </div>
                    <div className="bg-card text-card-foreground border rounded-lg px-4 py-2 text-sm">
                        <span className="text-muted-foreground block text-xs">Unidades</span>
                        <span className="font-bold">{totalUnits}</span>
                    </div>
                </div>
            </div>

            {/* Toolbar */}
            <div className="flex gap-4 items-center bg-card p-4 rounded-lg border shadow-sm">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <input
                        type="text"
                        placeholder="Buscar por SKU, Marca o Modelo..."
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 pl-8 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                <button
                    onClick={() => setShowNewProductModal(true)}
                    className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 text-sm font-medium"
                >
                    <Plus className="w-4 h-4" />
                    Nuevo Producto
                </button>
            </div>

            {/* NEW PRODUCT MODAL */}
            {showNewProductModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="bg-background border rounded-lg shadow-lg w-full max-w-md p-6">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-semibold">Agregar Nuevo Producto</h3>
                            <button onClick={() => setShowNewProductModal(false)} className="text-muted-foreground hover:text-foreground">✕</button>
                        </div>
                        <form onSubmit={handleCreateProduct} className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium mb-1">Marca</label>
                                    <input
                                        required
                                        className="w-full bg-background border rounded px-3 py-2 text-sm"
                                        value={newProduct.brand}
                                        onChange={e => setNewProduct({ ...newProduct, brand: e.target.value })}
                                        placeholder="Ej: Nike"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium mb-1">Categoría</label>
                                    <select
                                        className="w-full bg-background border rounded px-3 py-2 text-sm"
                                        value={newProduct.category}
                                        onChange={e => setNewProduct({ ...newProduct, category: e.target.value })}
                                    >
                                        <option value="casual">Casual</option>
                                        <option value="running">Running</option>
                                        <option value="training">Training</option>
                                        <option value="basketball">Basketball</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1">Modelo</label>
                                <input
                                    required
                                    className="w-full bg-background border rounded px-3 py-2 text-sm"
                                    value={newProduct.model}
                                    onChange={e => setNewProduct({ ...newProduct, model: e.target.value })}
                                    placeholder="Ej: Air Max 90"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium mb-1">SKU</label>
                                    <input
                                        required
                                        className="w-full bg-background border rounded px-3 py-2 text-sm font-mono"
                                        value={newProduct.sku}
                                        onChange={e => setNewProduct({ ...newProduct, sku: e.target.value.toUpperCase() })}
                                        placeholder="NK-AIR-001"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium mb-1">Precio (COP)</label>
                                    <input
                                        type="number"
                                        required
                                        className="w-full bg-background border rounded px-3 py-2 text-sm"
                                        value={newProduct.price_cents || ''}
                                        onChange={e => setNewProduct({ ...newProduct, price_cents: Number(e.target.value) })}
                                        placeholder="0"
                                    />
                                </div>
                            </div>

                            {/* Initial Stock Section */}
                            <div className="border-t pt-4 mt-2">
                                <div className="flex justify-between items-center mb-2">
                                    <h4 className="text-sm font-semibold flex items-center gap-2">
                                        <Package className="w-3 h-3" /> Inventario Inicial (Tallas)
                                    </h4>
                                    <button
                                        type="button"
                                        onClick={addVariantRow}
                                        className="text-xs bg-secondary px-2 py-1 rounded hover:bg-secondary/80"
                                    >
                                        + Agregar Fila
                                    </button>
                                </div>
                                <div className="space-y-2 max-h-40 overflow-y-auto">
                                    {newProduct.initial_variants.map((variant, index) => (
                                        <div key={index} className="flex gap-2 items-center">
                                            <input
                                                type="number"
                                                className="w-20 bg-background border rounded px-2 py-1 text-sm"
                                                placeholder="Talla"
                                                value={variant.size}
                                                onChange={e => updateVariantRow(index, 'size', e.target.value)}
                                            />
                                            <input
                                                type="number"
                                                className="w-20 bg-background border rounded px-2 py-1 text-sm"
                                                placeholder="Cant."
                                                value={variant.stock}
                                                onChange={e => updateVariantRow(index, 'stock', e.target.value)}
                                            />
                                            {index > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => removeVariantRow(index)}
                                                    className="text-red-500 hover:text-red-700"
                                                >
                                                    ✕
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="flex justify-end gap-2 pt-4 border-t">
                                <button
                                    type="button"
                                    onClick={() => setShowNewProductModal(false)}
                                    className="px-4 py-2 text-sm font-medium hover:bg-muted rounded"
                                >
                                    Cancelar
                                </button>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="bg-primary text-primary-foreground px-4 py-2 rounded text-sm font-medium hover:bg-primary/90"
                                >
                                    {loading ? 'Guardando...' : 'Crear Producto'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            <div className="border border-border rounded-lg overflow-hidden bg-white shadow-sm">
                <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b">
                        <tr>
                            <th className="px-6 py-3 w-12"></th>
                            <th className="px-6 py-3">Producto</th>
                            <th className="px-6 py-3">Categoría</th>
                            <th className="px-6 py-3 text-right">Precio</th>
                            <th className="px-6 py-3 text-center">Stock Total</th>
                            <th className="px-6 py-3 text-center">Estado</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {filteredProducts.map((product) => {
                            const totalStock = product.product_variants.reduce((acc, v) => acc + v.stock, 0);
                            const isExpanded = expandedRows.has(product.id);
                            const isLowStock = totalStock < 5;

                            return (
                                <div key={product.id} style={{ display: 'contents' }}>
                                    <tr className={`hover:bg-muted/50 transition-colors ${isExpanded ? 'bg-muted/30' : ''}`}>
                                        <td className="px-6 py-4 text-center cursor-pointer" onClick={() => toggleRow(product.id)}>
                                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                        </td>
                                        <td className="px-6 py-4 font-medium">
                                            <div className="flex flex-col">
                                                <span className="text-base text-foreground">{product.brand} {product.model}</span>
                                                <span className="text-xs text-muted-foreground font-mono">{product.sku}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80">
                                                {product.category}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right font-mono">
                                            {formatCurrency(product.price_cents)}
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            <div className="flex items-center justify-center gap-2">
                                                <span className={`font-bold ${isLowStock ? 'text-red-600' : ''}`}>
                                                    {totalStock}
                                                </span>
                                                {isLowStock && <AlertTriangle className="w-4 h-4 text-amber-500" />}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`w-2 h-2 rounded-full inline-block ${product.active ? 'bg-green-500' : 'bg-gray-300'}`}></span>
                                        </td>
                                    </tr>

                                    {/* EXPANDED VARIANT DETAILS */}
                                    {isExpanded && (
                                        <tr className="bg-muted/20 shadow-inner">
                                            <td colSpan={6} className="p-0">
                                                <div className="p-4 pl-16 grid gap-4">
                                                    <div className="flex justify-between items-center mb-2">
                                                        <h4 className="font-semibold text-xs uppercase text-muted-foreground flex items-center gap-2">
                                                            <Package className="w-3 h-3" /> Detalle de Variantes (Tallas)
                                                        </h4>
                                                        <button
                                                            onClick={() => setAddingVariantTo(product.id)}
                                                            className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded hover:bg-primary/90"
                                                        >
                                                            + Agregar Talla
                                                        </button>
                                                    </div>

                                                    {/* Inline Add Variant Form */}
                                                    {addingVariantTo === product.id && (
                                                        <div className="bg-background border rounded p-3 mb-4 flex gap-4 items-end shadow-sm animate-in fade-in slide-in-from-top-1">
                                                            <div>
                                                                <label className="block text-xs font-medium mb-1">Talla</label>
                                                                <input
                                                                    type="number"
                                                                    className="w-20 border rounded px-2 py-1 text-sm"
                                                                    value={newVariant.size}
                                                                    onChange={e => setNewVariant({ ...newVariant, size: e.target.value })}
                                                                    placeholder="42"
                                                                />
                                                            </div>
                                                            <div>
                                                                <label className="block text-xs font-medium mb-1">Stock</label>
                                                                <input
                                                                    type="number"
                                                                    className="w-20 border rounded px-2 py-1 text-sm"
                                                                    value={newVariant.stock}
                                                                    onChange={e => setNewVariant({ ...newVariant, stock: e.target.value })}
                                                                    placeholder="10"
                                                                />
                                                            </div>
                                                            <div className="flex gap-2">
                                                                <button
                                                                    onClick={() => handleAddVariant(product.id)}
                                                                    disabled={loading}
                                                                    className="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700"
                                                                >
                                                                    Guardar
                                                                </button>
                                                                <button
                                                                    onClick={() => setAddingVariantTo(null)}
                                                                    className="bg-secondary text-secondary-foreground px-3 py-1 rounded text-sm hover:bg-secondary/80"
                                                                >
                                                                    Cancelar
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}

                                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                                        {product.product_variants.sort((a, b) => a.size - b.size).map(variant => {
                                                            const committed = committedStock[variant.id] || 0;
                                                            const available = variant.stock - committed;
                                                            const variantLowStock = available < 2;

                                                            return (
                                                                <div key={variant.id} className={`flex items-center justify-between p-3 rounded border bg-background ${variantLowStock ? 'border-red-200 bg-red-50' : 'border-border'}`}>
                                                                    <div className="flex items-center gap-3">
                                                                        <div className="flex items-center justify-center w-8 h-8 rounded bg-secondary text-secondary-foreground font-bold text-sm">
                                                                            {variant.size}
                                                                        </div>
                                                                        <div className="text-xs">
                                                                            <div className="text-muted-foreground">Físico: <span className="font-mono text-foreground font-medium">{variant.stock}</span></div>
                                                                            <div className="text-muted-foreground">Comprom.: <span className="font-mono text-foreground font-medium">{committed}</span></div>
                                                                        </div>
                                                                    </div>
                                                                    <div className="text-right">
                                                                        <div className="text-xs text-muted-foreground">Disponible</div>
                                                                        <div className={`font-bold text-lg ${available <= 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                                            {available}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                        {product.product_variants.length === 0 && (
                                                            <div className="col-span-3 text-center text-sm text-yellow-600 bg-yellow-50 p-2 rounded border border-yellow-200">
                                                                ⚠ Este producto no tiene tallas asignadas.
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </div>
                            );
                        })}
                    </tbody>
                </table>
                {filteredProducts.length === 0 && !loading && (
                    <div className="p-8 text-center text-muted-foreground">
                        No se encontraron productos que coincidan con la búsqueda.
                    </div>
                )}
            </div>
        </div>
    );
}

