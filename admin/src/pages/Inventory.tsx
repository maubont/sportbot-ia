import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Plus, Search, Edit, Trash2, Image as ImageIcon, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Product = {
    id: string;
    brand: string;
    model: string;
    sku: string;
    category: string;
    price_cents: number;
    active: boolean;
    variants?: Variant[];
    media?: ProductMedia[];
    total_stock?: number;
    committed_stock?: number;
    available_stock?: number;
};

type Variant = {
    id: string;
    size: number;
    stock: number;
    reserved?: number; // Calculated dynamically
};

type ProductMedia = {
    id: string;
    url: string;
    is_primary: boolean;
};

export default function Inventory() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [isModalOpen, setIsModalOpen] = useState(false);

    // Edit/Create State
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [newProduct, setNewProduct] = useState({
        brand: '',
        model: '',
        sku: '',
        category: 'casual',
        price_cents: 0
    });
    // For new product creation variants
    const [initialVariants, setInitialVariants] = useState<{ size: string, stock: string }[]>([{ size: '', stock: '' }]);

    // For editing stock inline (modal)
    const [addingVariantTo, setAddingVariantTo] = useState<string | null>(null);
    const [newVariant, setNewVariant] = useState({ size: '', stock: '' });

    // Image Upload State
    const [uploadingImage, setUploadingImage] = useState(false);

    useEffect(() => {
        fetchInventoryData();
    }, []);

    async function fetchInventoryData() {
        setLoading(true);
        // 1. Fetch Products with Variants AND Media
        const { data: prods, error } = await supabase
            .from('products')
            .select(`
                *,
                variants:product_variants(*),
                media:product_media(*)
            `)
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Error fetching inventory:", error);
            setLoading(false);
            return;
        }

        // 2. Fetch Active Orders to calculate "Committed" stock
        const { data: activeOrders } = await supabase
            .from('orders')
            .select(`
                id,
                items:order_items(
                    variant_id,
                    qty
                )
            `)
            .in('status', ['paid', 'processing']); // Only paid/processing reserver stock. 'awaiting_payment' could also reserve if desired.

        // Create a map of committed stock per variant_id
        const committedMap = new Map<string, number>();
        if (activeOrders) {
            activeOrders.forEach(order => {
                order.items.forEach((item: any) => {
                    if (item.variant_id) {
                        const current = committedMap.get(item.variant_id) || 0;
                        committedMap.set(item.variant_id, current + item.qty);
                    }
                });
            });
        }

        // 3. Process Data
        const processed = prods.map((p: any) => {
            let totalPhysical = 0;
            let totalCommitted = 0;

            const processedVariants = p.variants.map((v: any) => {
                const committed = committedMap.get(v.id) || 0;
                totalPhysical += v.stock;
                totalCommitted += committed;
                return {
                    ...v,
                    reserved: committed
                };
            });

            // Sort media: Primary first
            const sortedMedia = p.media?.sort((a: any, b: any) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));

            return {
                ...p,
                variants: processedVariants.sort((a: any, b: any) => a.size - b.size),
                media: sortedMedia,
                total_stock: totalPhysical,
                committed_stock: totalCommitted,
                available_stock: totalPhysical - totalCommitted
            };
        });

        setProducts(processed);
        setLoading(false);
    }

    async function handleSaveProduct() {
        if (!newProduct.brand || !newProduct.model || !newProduct.sku) {
            alert("Complete todos los campos obligatorios");
            return;
        }

        setLoading(true);
        try {
            if (editingProduct) {
                // Update
                const { error } = await supabase
                    .from('products')
                    .update({
                        brand: newProduct.brand,
                        model: newProduct.model,
                        sku: newProduct.sku,
                        category: newProduct.category,
                        price_cents: newProduct.price_cents * 100
                    })
                    .eq('id', editingProduct.id);
                if (error) throw error;
            } else {
                // Create
                const { data: prodData, error: prodError } = await supabase
                    .from('products')
                    .insert({
                        brand: newProduct.brand,
                        model: newProduct.model,
                        sku: newProduct.sku,
                        category: newProduct.category,
                        price_cents: newProduct.price_cents * 100,
                        active: true
                    })
                    .select()
                    .single();

                if (prodError) throw prodError;

                // Add initial variants
                const validVariants = initialVariants.filter(v => v.size && v.stock);
                if (validVariants.length > 0 && prodData) {
                    const variantsToInsert = validVariants.map(v => ({
                        product_id: prodData.id,
                        size: Number(v.size),
                        stock: Number(v.stock)
                    }));
                    const { error: variantError } = await supabase
                        .from('product_variants')
                        .insert(variantsToInsert);
                    if (variantError) console.error("Error inserting variants:", variantError);
                }
            }

            closeModal();
            fetchInventoryData();
        } catch (error: any) {
            alert("Error: " + error.message);
        } finally {
            setLoading(false);
        }
    }

    async function handleAddVariant(productId: string) {
        if (!newVariant.size || !newVariant.stock) return;
        setLoading(true);
        try {
            // 1. Check for ALL existing variants with this size (to detect duplicates)
            const { data: existingVariants, error: fetchError } = await supabase
                .from('product_variants')
                .select('id, stock')
                .eq('product_id', productId)
                .eq('size', Number(newVariant.size));

            if (fetchError) throw fetchError;

            let error;

            if (existingVariants && existingVariants.length > 0) {
                // FOUND 1 OR MORE - Auto-Merge Logic
                const totalCurrentStock = existingVariants.reduce((sum, v) => sum + (v.stock || 0), 0);
                const newStockTotal = totalCurrentStock + Number(newVariant.stock);

                const masterVariant = existingVariants[0];

                // Update Master
                const { error: updateError } = await supabase
                    .from('product_variants')
                    .update({ stock: newStockTotal })
                    .eq('id', masterVariant.id);

                if (updateError) throw updateError;

                // Delete duplicates
                if (existingVariants.length > 1) {
                    const duplicatesToDelete = existingVariants.slice(1).map(v => v.id);
                    await supabase.from('product_variants').delete().in('id', duplicatesToDelete);
                }

            } else {
                // Insert new
                const { error: insertError } = await supabase
                    .from('product_variants')
                    .insert({
                        product_id: productId,
                        size: Number(newVariant.size),
                        stock: Number(newVariant.stock)
                    });
                error = insertError;
            }

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

    async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>, productId: string) {
        if (!e.target.files || e.target.files.length === 0) return;
        setUploadingImage(true);

        try {
            const file = e.target.files[0];
            const fileExt = file.name.split('.').pop();
            const fileName = `${productId}/${Date.now()}.${fileExt}`;
            const filePath = `${fileName}`;

            // 1. Upload to Storage
            const { error: uploadError } = await supabase.storage
                .from('product-media')
                .upload(filePath, file, {
                    cacheControl: '3600',
                    upsert: false
                });

            if (uploadError) throw uploadError;

            // 2. Get Public URL
            const { data: { publicUrl } } = supabase.storage
                .from('product-media')
                .getPublicUrl(filePath);

            // 3. Insert into product_media
            const { error: dbError } = await supabase
                .from('product_media')
                .insert({
                    product_id: productId,
                    url: publicUrl,
                    storage_path: filePath,
                    media_type: 'image',
                    is_primary: false // User can set primary later
                });

            if (dbError) throw dbError;

            // Trigger fetch to update UI immediately inside modal if desired or just main list
            // But main list is better trigger. 
            // Also need to update editingProduct if open.

            // To update locally without fetch (faster UI):
            const newMedia = {
                id: 'temp-' + Date.now(),
                url: publicUrl,
                is_primary: false,
                storage_path: filePath
            };

            // 4. Update Local State (Modal & List)
            setEditingProduct(prev => prev ? ({
                ...prev,
                media: [...(prev.media || []), newMedia as any]
            }) : null);

            await fetchInventoryData(); // Background sync

        } catch (error: any) {
            console.error("Upload error:", error);
            alert("Error uploading image: " + error.message);
        } finally {
            setUploadingImage(false);
        }
    }

    async function handleSetPrimaryImage(mediaId: string, productId: string) {
        // Optimistic UI Update
        setEditingProduct(prev => prev ? ({
            ...prev,
            media: prev.media?.map(m => ({
                ...m,
                is_primary: m.id === mediaId
            }))
        }) : null);

        // Unset previous primary
        await supabase
            .from('product_media')
            .update({ is_primary: false })
            .eq('product_id', productId);

        // Set new primary
        await supabase
            .from('product_media')
            .update({ is_primary: true })
            .eq('id', mediaId);

        await fetchInventoryData();
    }

    async function handleDeleteImage(mediaId: string, storagePath: string) {
        if (!confirm("Are you sure you want to delete this image?")) return;

        // Optimistic UI Update
        setEditingProduct(prev => prev ? ({
            ...prev,
            media: prev.media?.filter(m => m.id !== mediaId)
        }) : null);

        // Delete from Storage
        if (storagePath) {
            await supabase.storage.from('product-media').remove([storagePath]);
        }

        // Delete from DB
        await supabase.from('product_media').delete().eq('id', mediaId);

        await fetchInventoryData();
    }


    function openModal(product?: Product) {
        if (product) {
            setEditingProduct(product);
            setNewProduct({
                brand: product.brand,
                model: product.model,
                sku: product.sku,
                category: product.category || 'casual',
                price_cents: product.price_cents / 100
            });
            setInitialVariants([]);
        } else {
            setEditingProduct(null);
            setNewProduct({ brand: '', model: '', sku: '', category: 'casual', price_cents: 0 });
            setInitialVariants([{ size: '', stock: '' }]);
            // Generate Random SKU
            setNewProduct(prev => ({ ...prev, sku: `NK-${Math.floor(Math.random() * 10000)}` }));
        }
        setIsModalOpen(true);
    }

    function closeModal() {
        setIsModalOpen(false);
        setEditingProduct(null);
    }

    const filteredProducts = products.filter(p =>
        p.model.toLowerCase().includes(search.toLowerCase()) ||
        p.sku.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-3xl font-bold tracking-tight">Inventory</h2>
                <button
                    onClick={() => openModal()}
                    className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90"
                >
                    <Plus className="w-4 h-4" />
                    New Product
                </button>
            </div>

            {/* Filters */}
            <div className="flex gap-4 items-center bg-card p-4 rounded-lg border border-border">
                <div className="relative flex-1 max-w-sm">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <input
                        className="pl-9 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        placeholder="Search by model or SKU..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {/* Products Table */}
            <div className="border border-border rounded-lg overflow-hidden bg-card">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border bg-muted/50 text-left">
                            <th className="p-4 font-medium text-muted-foreground w-[80px]">Image</th>
                            <th className="p-4 font-medium text-muted-foreground">Product Details</th>
                            <th className="p-4 font-medium text-muted-foreground">Category</th>
                            <th className="p-4 font-medium text-muted-foreground">Price (COP)</th>
                            <th className="p-4 font-medium text-muted-foreground">Stock Overview</th>
                            <th className="p-4 font-medium text-muted-foreground text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Loading inventory...</td></tr>
                        ) : filteredProducts.map((product) => (
                            <tr key={product.id} className="border-b border-border hover:bg-muted/10 transition-colors">
                                {/* Image Column */}
                                <td className="p-4">
                                    <div className="w-12 h-12 rounded-md bg-muted overflow-hidden flex items-center justify-center border border-border">
                                        {product.media && product.media.length > 0 ? (
                                            <img
                                                src={product.media.find(m => m.is_primary)?.url || product.media[0].url}
                                                alt={product.model}
                                                className="w-full h-full object-cover"
                                            />
                                        ) : (
                                            <ImageIcon className="w-5 h-5 text-muted-foreground/50" />
                                        )}
                                    </div>
                                </td>

                                <td className="p-4">
                                    <div className="font-medium text-base">{product.brand} {product.model}</div>
                                    <div className="text-xs text-muted-foreground font-mono">{product.sku}</div>
                                    {/* Inline Stock Edit Trigger */}
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {product.variants?.map(v => (
                                            <div key={v.id}
                                                className={cn(
                                                    "px-2 py-1 rounded text-xs border flex items-center gap-1",
                                                    (v.stock) <= 0 ? "bg-red-500/10 border-red-500/20 text-red-700 dark:text-red-400" :
                                                        (v.stock) < 3 ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-700 dark:text-yellow-400" :
                                                            "bg-background border-border"
                                                )}
                                            >
                                                <span className="font-bold">{v.size}</span>
                                                <span className="text-muted-foreground mx-1">|</span>
                                                <span className={cn((v.stock) <= 0 && "font-bold")}>
                                                    {v.stock}
                                                </span>
                                                {v.reserved! > 0 && (
                                                    <span className="text-[10px] text-blue-500 ml-1" title="Physical Total = Available + Reserved">
                                                        (R:{v.reserved})
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                        <button
                                            onClick={() => setAddingVariantTo(addingVariantTo === product.id ? null : product.id)}
                                            className="px-2 py-1 rounded text-xs border border-dashed border-primary/50 text-primary hover:bg-primary/5 transition-colors"
                                        >
                                            + Stock
                                        </button>
                                    </div>

                                    {/* Inline Add Stock Form */}
                                    {addingVariantTo === product.id && (
                                        <div className="mt-2 p-2 bg-muted/30 rounded border border-border flex gap-2 items-center slide-in-from-top-2 animate-in duration-200">
                                            <input
                                                type="number" placeholder="Size" className="w-16 px-2 py-1 text-xs border rounded bg-background"
                                                value={newVariant.size} onChange={e => setNewVariant({ ...newVariant, size: e.target.value })}
                                            />
                                            <input
                                                type="number" placeholder="Qty" className="w-16 px-2 py-1 text-xs border rounded bg-background"
                                                value={newVariant.stock} onChange={e => setNewVariant({ ...newVariant, stock: e.target.value })}
                                            />
                                            <button
                                                disabled={loading}
                                                onClick={() => handleAddVariant(product.id)}
                                                className="px-3 py-1 bg-primary text-primary-foreground text-xs rounded hover:bg-primary/90"
                                            >
                                                Add
                                            </button>
                                        </div>
                                    )}
                                </td>

                                <td className="p-4">
                                    <span className="capitalize px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-xs">
                                        {product.category}
                                    </span>
                                </td>
                                <td className="p-4 font-mono">
                                    ${(product.price_cents / 100).toLocaleString('es-CO')}
                                </td>
                                <td className="p-4">
                                    <div className="text-sm">
                                        <span className={cn("font-bold", product.total_stock! <= 0 ? "text-red-500" : "text-green-500")}>
                                            {product.total_stock} Available
                                        </span>
                                        <div className="text-xs text-muted-foreground">
                                            {/* Logic: Total = Available + Reserved */}
                                            {product.total_stock! + product.committed_stock!} Total - {product.committed_stock} Reserved
                                        </div>
                                    </div>
                                </td>
                                <td className="p-4 text-right">
                                    <div className="flex justify-end gap-2">
                                        <button
                                            onClick={() => openModal(product)}
                                            className="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground"
                                        >
                                            <Edit className="w-4 h-4" />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-card border border-border w-full max-w-lg rounded-lg shadow-lg flex flex-col max-h-[90vh]">
                        <div className="p-6 border-b border-border flex justify-between items-center">
                            <h3 className="text-lg font-semibold">{editingProduct ? 'Edit Product' : 'New Product'}</h3>
                            <button onClick={closeModal}><X className="w-4 h-4" /></button>
                        </div>

                        <div className="p-6 overflow-y-auto space-y-4 flex-1">
                            {/* Basic Info */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Brand</label>
                                    <input
                                        className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                        value={newProduct.brand} onChange={e => setNewProduct({ ...newProduct, brand: e.target.value })}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Model</label>
                                    <input
                                        className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                        value={newProduct.model} onChange={e => setNewProduct({ ...newProduct, model: e.target.value })}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">SKU</label>
                                    <input
                                        className="w-full px-3 py-2 rounded-md border border-input bg-background font-mono"
                                        value={newProduct.sku} onChange={e => setNewProduct({ ...newProduct, sku: e.target.value })}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Price (COP)</label>
                                    <input
                                        type="number"
                                        className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                        value={newProduct.price_cents} onChange={e => setNewProduct({ ...newProduct, price_cents: Number(e.target.value) })}
                                    />
                                </div>
                            </div>

                            {/* Image Management Section (Only in Edit Mode) */}
                            {editingProduct && (
                                <div className="space-y-3 pt-4 border-t border-border">
                                    <label className="text-sm font-medium flex items-center gap-2">
                                        <ImageIcon className="w-4 h-4" />
                                        Product Images
                                    </label>

                                    <div className="grid grid-cols-4 gap-2">
                                        {/* Existing Images */}
                                        {editingProduct.media?.map(m => (
                                            <div key={m.id} className="relative group aspect-square rounded-md overflow-hidden border border-border">
                                                <img src={m.url} className="w-full h-full object-cover" />
                                                {/* Actions Overlay */}
                                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                                                    <button
                                                        onClick={() => handleSetPrimaryImage(m.id, editingProduct.id)}
                                                        className={cn("p-1 rounded-full", m.is_primary ? "bg-yellow-400 text-black" : "bg-white/20 text-white hover:bg-white/40")}
                                                        title="Set Primary"
                                                    >
                                                        <Star className={cn("w-4 h-4", m.is_primary && "fill-current")} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteImage(m.id, (m as any).storage_path)}
                                                        className="p-1 rounded-full bg-red-500/80 text-white hover:bg-red-600"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                                {m.is_primary && (
                                                    <div className="absolute top-1 right-1 bg-yellow-400 text-black text-[10px] px-1 rounded font-bold">
                                                        MAIN
                                                    </div>
                                                )}
                                            </div>
                                        ))}

                                        {/* Upload Button */}
                                        <label className={cn(
                                            "aspect-square rounded-md border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center cursor-pointer hover:bg-muted/50 transition-colors",
                                            uploadingImage && "opacity-50 cursor-not-allowed"
                                        )}>
                                            {uploadingImage ? (
                                                <span className="text-xs text-muted-foreground">Uploading...</span>
                                            ) : (
                                                <>
                                                    <Plus className="w-6 h-6 text-muted-foreground" />
                                                    <span className="text-[10px] text-muted-foreground mt-1">Add Photo</span>
                                                </>
                                            )}
                                            <input
                                                type="file"
                                                accept="image/*"
                                                className="hidden"
                                                onChange={(e) => handleImageUpload(e, editingProduct.id)}
                                                disabled={uploadingImage}
                                            />
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Initial Variants (Only for New Product) */}
                            {!editingProduct && (
                                <div className="space-y-2 pt-4 border-t border-border">
                                    <label className="text-sm font-medium">Initial Sizes</label>
                                    {initialVariants.map((v, idx) => (
                                        <div key={idx} className="flex gap-2">
                                            <input
                                                type="number" placeholder="Size (e.g. 40)" className="flex-1 px-3 py-2 rounded-md border border-input bg-background"
                                                value={v.size} onChange={e => {
                                                    const newVars = [...initialVariants];
                                                    newVars[idx].size = e.target.value;
                                                    setInitialVariants(newVars);
                                                }}
                                            />
                                            <input
                                                type="number" placeholder="Stock" className="flex-1 px-3 py-2 rounded-md border border-input bg-background"
                                                value={v.stock} onChange={e => {
                                                    const newVars = [...initialVariants];
                                                    newVars[idx].stock = e.target.value;
                                                    setInitialVariants(newVars);
                                                }}
                                            />
                                            {idx === initialVariants.length - 1 && (
                                                <button
                                                    onClick={() => setInitialVariants([...initialVariants, { size: '', stock: '' }])}
                                                    className="p-2 border rounded-md hover:bg-muted"
                                                >
                                                    <Plus className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                        </div>

                        <div className="p-6 border-t border-border flex justify-end gap-2">
                            <button onClick={closeModal} className="px-4 py-2 text-sm hover:underline">Cancel</button>
                            <button
                                onClick={handleSaveProduct}
                                disabled={loading}
                                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                            >
                                {loading ? 'Saving...' : 'Save Product'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
