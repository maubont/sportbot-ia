import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Plus, Search, Edit, Trash2, Image as ImageIcon, Star, X, Power, PackagePlus, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    COLOR_ORDER,
    COLOR_VOCABULARY,
    normalizeColors,
    parseStockQuantity,
    parseVariantSize,
    validateProductDraft,
} from "@/lib/catalog";

type Product = {
    id: string;
    brand: string;
    model: string;
    sku: string;
    category: string;
    price_cents: number;
    default_unit_cost_cents?: number;
    active: boolean;
    colors?: string[];
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
    reserved?: number | null;
};

type ProductMedia = {
    id: string;
    url: string;
    is_primary: boolean;
    storage_path?: string;
};

type ProductRow = Omit<Product, "variants" | "media"> & {
    variants?: Variant[];
    media?: ProductMedia[];
};

type ProductCostRow = {
    product_id: string;
    default_unit_cost_cents: number | null;
};

function getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
        const candidate = error as { code?: string; message?: string };
        if (candidate.code === "23505") {
            return "Ya existe un registro con ese valor único (SKU o talla).";
        }
        if (candidate.message) return candidate.message;
    }
    return String(error);
}

export default function Inventory() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionNotice, setActionNotice] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [modalError, setModalError] = useState<string | null>(null);

    // Edit/Create State
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [newProduct, setNewProduct] = useState({
        brand: '',
        model: '',
        sku: '',
        category: 'casual',
        price_cents: 0,
        default_unit_cost_cents: 0,
        colors: [] as string[]
    });
    // For new product creation variants
    const [initialVariants, setInitialVariants] = useState<{ size: string, stock: string }[]>([{ size: '', stock: '' }]);

    // For editing stock inline (modal)
    const [addingVariantTo, setAddingVariantTo] = useState<string | null>(null);
    const [newVariant, setNewVariant] = useState({ size: '', stock: '' });
    const [savingVariant, setSavingVariant] = useState(false);

    // Reposición de una talla existente: nunca fusiona ni borra variantes.
    const [restockTarget, setRestockTarget] = useState<Variant | null>(null);
    const [restockQty, setRestockQty] = useState('');
    const [savingRestock, setSavingRestock] = useState(false);
    const [togglingActiveId, setTogglingActiveId] = useState<string | null>(null);

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
            setLoadError(`No se pudo cargar el inventario: ${error.message}`);
            setProducts([]);
            setLoading(false);
            return;
        }

        setLoadError(null);

        const { data: costs, error: costsError } = await supabase
            .from('product_costs')
            .select('product_id, default_unit_cost_cents');

        if (costsError) {
            console.error("Error fetching product costs:", costsError);
            setLoadError(`No se pudieron cargar los costos unitarios; se bloqueó la edición para evitar guardar márgenes incorrectos: ${costsError.message}`);
            setProducts([]);
            setLoading(false);
            return;
        }

        const costsByProduct = new Map(
            ((costs as ProductCostRow[] | null) || []).map((cost) => [
                cost.product_id,
                cost.default_unit_cost_cents || 0
            ])
        );

        // 2. Process inventory using canonical stock semantics:
        // stock = physical, reserved = awaiting_payment hold, available = stock - reserved.
        const processed = (prods as ProductRow[]).map((p) => {
            let totalPhysical = 0;
            let totalReserved = 0;

            const processedVariants = (p.variants || []).map((v) => {
                const reserved = v.reserved || 0;
                totalPhysical += v.stock || 0;
                totalReserved += reserved;
                return {
                    ...v,
                    reserved
                };
            });

            // Sort media: Primary first
            const sortedMedia = p.media?.sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));

            return {
                ...p,
                default_unit_cost_cents: costsByProduct.get(p.id) || 0,
                variants: processedVariants.sort((a, b) => a.size - b.size),
                media: sortedMedia,
                total_stock: totalPhysical,
                committed_stock: totalReserved,
                available_stock: totalPhysical - totalReserved
            };
        });

        setProducts(processed);
        setLoading(false);
    }

    async function handleSaveProduct() {
        if (loadError) {
            setModalError("No se puede guardar mientras falla la carga del inventario o sus costos. Reintenta la carga primero.");
            return;
        }

        const validationError = validateProductDraft({
            brand: newProduct.brand,
            model: newProduct.model,
            sku: newProduct.sku,
            price: newProduct.price_cents,
            cost: newProduct.default_unit_cost_cents,
            colors: newProduct.colors
        });
        if (validationError) {
            setModalError(validationError);
            return;
        }

        const initialRows = initialVariants.filter(v => v.size.trim() || v.stock.trim());
        const parsedInitial: { size: number; stock: number }[] = [];
        for (const [index, row] of initialRows.entries()) {
            const size = parseVariantSize(row.size);
            const stock = parseStockQuantity(row.stock);
            if (size === null || stock === null) {
                setModalError(`Fila ${index + 1}: usa una talla de 1 a 60 (media talla permitida) y una cantidad entera positiva.`);
                return;
            }
            if (parsedInitial.some(v => v.size === size)) {
                setModalError(`La talla ${size} está repetida en las tallas iniciales.`);
                return;
            }
            parsedInitial.push({ size, stock });
        }

        setModalError(null);
        setLoading(true);
        try {
            const priceCents = Math.round(newProduct.price_cents * 100);
            const costCents = Math.max(0, Math.round(newProduct.default_unit_cost_cents * 100));
            const colors = normalizeColors(newProduct.colors);
            let savedProductId = editingProduct?.id;

            if (editingProduct) {
                // Update
                const { error } = await supabase
                    .from('products')
                    .update({
                        brand: newProduct.brand.trim(),
                        model: newProduct.model.trim(),
                        sku: newProduct.sku.trim().toUpperCase(),
                        category: newProduct.category,
                        price_cents: priceCents,
                        colors,
                        active: editingProduct.active
                    })
                    .eq('id', editingProduct.id);
                if (error) throw error;
            } else {
                // Create
                const { data: prodData, error: prodError } = await supabase
                    .from('products')
                    .insert({
                        brand: newProduct.brand.trim(),
                        model: newProduct.model.trim(),
                        sku: newProduct.sku.trim().toUpperCase(),
                        category: newProduct.category,
                        price_cents: priceCents,
                        active: true,
                        colors
                    })
                    .select()
                    .single();

                if (prodError) throw prodError;
                savedProductId = prodData.id;

                // Add initial variants
                if (parsedInitial.length > 0 && prodData) {
                    const { error: variantError } = await supabase
                        .from('product_variants')
                        .insert(parsedInitial.map(v => ({
                            product_id: prodData.id,
                            size: v.size,
                            stock: v.stock
                        })));
                    if (variantError) {
                        // Compensa la creación para no dejar un producto sin tallas.
                        await supabase.from('products').delete().eq('id', prodData.id);
                        throw variantError;
                    }
                }
            }

            if (savedProductId) {
                const { error: costError } = await supabase
                    .from('product_costs')
                    .upsert({
                        product_id: savedProductId,
                        default_unit_cost_cents: costCents,
                        source: 'manual'
                    }, { onConflict: 'product_id' });

                if (costError) throw costError;
            }

            closeModal();
            await fetchInventoryData();
        } catch (error) {
            setModalError(getErrorMessage(error));
        } finally {
            setLoading(false);
        }
    }

    async function handleAddVariant(productId: string) {
        const size = parseVariantSize(newVariant.size);
        const stock = parseStockQuantity(newVariant.stock);
        if (size === null) {
            setActionError("La talla debe estar entre 1 y 60 (media talla permitida).");
            return;
        }
        if (stock === null) {
            setActionError("La cantidad debe ser un entero positivo.");
            return;
        }

        setSavingVariant(true);
        setActionError(null);
        setActionNotice(null);
        try {
            const { error } = await supabase
                .from('product_variants')
                .insert({
                    product_id: productId,
                    size,
                    stock
                });

            if (error) {
                if (error.code === '23505') {
                    throw new Error(`La talla ${size} ya existe. Usa "Reponer" sobre esa talla en vez de crearla otra vez.`);
                }
                throw error;
            }

            setNewVariant({ size: '', stock: '' });
            setAddingVariantTo(null);
            setActionNotice(`Talla ${size} agregada con ${stock} unidades.`);
            await fetchInventoryData();
        } catch (error) {
            setActionError(getErrorMessage(error));
        } finally {
            setSavingVariant(false);
        }
    }

    async function handleRestock(variant: Variant) {
        const qty = parseStockQuantity(restockQty);
        if (qty === null) {
            setActionError("La reposición debe ser un entero positivo (máximo 10.000).");
            return;
        }

        setSavingRestock(true);
        setActionError(null);
        setActionNotice(null);
        try {
            const { error } = await supabase.rpc('restock_variant', {
                p_variant_id: variant.id,
                p_qty: qty
            });
            if (error) throw error;

            setRestockTarget(null);
            setRestockQty('');
            setActionNotice(`Talla ${variant.size}: +${qty} unidades. El stock reservado no cambió.`);
            await fetchInventoryData();
        } catch (error) {
            setActionError(getErrorMessage(error));
        } finally {
            setSavingRestock(false);
        }
    }

    async function handleToggleActive(product: Product) {
        const nextActive = !product.active;
        if (!nextActive && !confirm(`¿Ocultar ${product.brand} ${product.model} de la vitrina y del bot?`)) {
            return;
        }

        setTogglingActiveId(product.id);
        setActionError(null);
        setActionNotice(null);
        try {
            const { error } = await supabase
                .from('products')
                .update({ active: nextActive })
                .eq('id', product.id);
            if (error) throw error;

            setActionNotice(nextActive
                ? `${product.brand} ${product.model} vuelve a la vitrina y al bot.`
                : `${product.brand} ${product.model} quedó oculto de la vitrina y del bot.`);
            await fetchInventoryData();
        } catch (error) {
            setActionError(getErrorMessage(error));
        } finally {
            setTogglingActiveId(null);
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
            const { data: mediaRow, error: dbError } = await supabase
                .from('product_media')
                .insert({
                    product_id: productId,
                    url: publicUrl,
                    storage_path: filePath,
                    media_type: 'image',
                    is_primary: false // User can set primary later
                })
                .select('id, url, is_primary, storage_path')
                .single();

            if (dbError) throw dbError;

            const newMedia = {
                id: mediaRow.id,
                url: mediaRow.url,
                is_primary: mediaRow.is_primary,
                storage_path: mediaRow.storage_path
            };

            // 4. Update Local State (Modal & List)
            setEditingProduct(prev => prev ? ({
                ...prev,
                media: [...(prev.media || []), newMedia]
            }) : null);

            await fetchInventoryData(); // Background sync

        } catch (error) {
            console.error("Upload error:", error);
            setModalError("Error al subir la imagen: " + getErrorMessage(error));
        } finally {
            setUploadingImage(false);
        }
    }

    async function handleSetPrimaryImage(mediaId: string) {
        const previousPrimaryId = editingProduct?.media?.find(m => m.is_primary)?.id;
        // Optimistic UI Update
        setEditingProduct(prev => prev ? ({
            ...prev,
            media: prev.media?.map(m => ({
                ...m,
                is_primary: m.id === mediaId
            }))
        }) : null);
        setModalError(null);

        try {
            const { error } = await supabase.rpc('set_primary_product_media', {
                p_media_id: mediaId
            });
            if (error) throw error;
            await fetchInventoryData();
        } catch (error) {
            setModalError(getErrorMessage(error));
            setEditingProduct(prev => prev ? ({
                ...prev,
                media: prev.media?.map(m => ({
                    ...m,
                    is_primary: m.id === previousPrimaryId
                }))
            }) : null);
            await fetchInventoryData();
        }
    }

    async function handleDeleteImage(mediaId: string, storagePath: string) {
        if (!confirm("Are you sure you want to delete this image?")) return;
        setModalError(null);

        // Optimistic UI Update
        setEditingProduct(prev => prev ? ({
            ...prev,
            media: prev.media?.filter(m => m.id !== mediaId)
        }) : null);

        // Delete from Storage
        if (storagePath) {
            const { error: storageError } = await supabase.storage.from('product-media').remove([storagePath]);
            if (storageError) {
                setModalError(`No se pudo borrar el archivo: ${getErrorMessage(storageError)}`);
            }
        }

        // Delete from DB
        const { error } = await supabase.from('product_media').delete().eq('id', mediaId);
        if (error) {
            setModalError(getErrorMessage(error));
        }

        await fetchInventoryData();
    }


    function openModal(product?: Product) {
        setModalError(null);
        if (product) {
            setEditingProduct(product);
            setNewProduct({
                brand: product.brand,
                model: product.model,
                sku: product.sku,
                category: product.category || 'casual',
                price_cents: product.price_cents / 100,
                default_unit_cost_cents: (product.default_unit_cost_cents || 0) / 100,
                colors: normalizeColors(product.colors || [])
            });
            setInitialVariants([]);
        } else {
            setEditingProduct(null);
            setNewProduct({
                brand: '',
                model: '',
                sku: `NK-${Math.floor(Math.random() * 10000)}`,
                category: 'casual',
                price_cents: 0,
                default_unit_cost_cents: 0,
                colors: []
            });
            setInitialVariants([{ size: '', stock: '' }]);
        }
        setIsModalOpen(true);
    }

    function closeModal() {
        setIsModalOpen(false);
        setEditingProduct(null);
        setModalError(null);
    }

    const filteredProducts = products.filter(p => {
        const matchesSearch =
            p.model.toLowerCase().includes(search.toLowerCase()) ||
            p.sku.toLowerCase().includes(search.toLowerCase());
        const matchesStatus =
            statusFilter === 'all' ||
            (statusFilter === 'active' ? p.active : !p.active);
        return matchesSearch && matchesStatus;
    });

    const activeCount = products.filter(p => p.active).length;

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Inventory</h2>
                    <p className="text-sm text-muted-foreground">
                        {activeCount} activos de {products.length}. Los inactivos no se ofrecen en la vitrina ni en el bot.
                    </p>
                </div>
                <button
                    onClick={() => openModal()}
                    disabled={loading || Boolean(loadError)}
                    className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90"
                >
                    <Plus className="w-4 h-4" />
                    New Product
                </button>
            </div>

            {loadError && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{loadError}</span>
                </div>
            )}
            {actionError && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{actionError}</span>
                </div>
            )}
            {actionNotice && (
                <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-900/40 dark:bg-green-950/40 dark:text-green-300">
                    {actionNotice}
                </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap gap-4 items-center bg-card p-4 rounded-lg border border-border">
                <div className="relative flex-1 max-w-sm">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <input
                        className="pl-9 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        placeholder="Search by model or SKU..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <div className="flex rounded-md border border-border overflow-hidden text-sm">
                    {([
                        ['all', 'Todas', products.length],
                        ['active', 'Activas', activeCount],
                        ['inactive', 'Inactivas', products.length - activeCount]
                    ] as const).map(([value, label, count]) => (
                        <button
                            key={value}
                            onClick={() => setStatusFilter(value)}
                            className={cn(
                                "px-3 py-2 transition-colors",
                                statusFilter === value
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-background hover:bg-muted"
                            )}
                        >
                            {label} ({count})
                        </button>
                    ))}
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
                            <th className="p-4 font-medium text-muted-foreground">Unit Cost</th>
                            <th className="p-4 font-medium text-muted-foreground">Stock Overview</th>
                            <th className="p-4 font-medium text-muted-foreground text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Loading inventory...</td></tr>
                        ) : filteredProducts.map((product) => (
                            <tr key={product.id} className={cn("border-b border-border hover:bg-muted/10 transition-colors", !product.active && "opacity-60")}>
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
                                    <div className="flex items-center gap-2">
                                        <div className="font-medium text-base">{product.brand} {product.model}</div>
                                        <span className={cn(
                                            "text-[10px] px-1.5 py-0.5 rounded-full border font-semibold tracking-wide",
                                            product.active
                                                ? "bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400"
                                                : "bg-muted border-border text-muted-foreground"
                                        )}>
                                            {product.active ? 'ACTIVE' : 'INACTIVE'}
                                        </span>
                                    </div>
                                    <div className="text-xs text-muted-foreground font-mono">{product.sku}</div>
                                    <div className="mt-1 flex flex-wrap items-center gap-2">
                                        {normalizeColors(product.colors || []).length > 0 ? (
                                            normalizeColors(product.colors || []).map(color => (
                                                <span key={color} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                                    <span
                                                        className="w-2.5 h-2.5 rounded-full border border-border"
                                                        style={{ backgroundColor: COLOR_VOCABULARY[color].hex }}
                                                    />
                                                    {COLOR_VOCABULARY[color].label}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="text-[11px] text-amber-600">Sin color asignado</span>
                                        )}
                                    </div>
                                    {/* Tallas: click para reponer */}
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {product.variants?.map(v => (
                                            <button
                                                key={v.id}
                                                type="button"
                                                onClick={() => {
                                                    setRestockTarget(restockTarget?.id === v.id ? null : v);
                                                    setRestockQty('');
                                                    setAddingVariantTo(null);
                                                    setActionError(null);
                                                }}
                                                title={`Reponer talla ${v.size}`}
                                                className={cn(
                                                    "px-2 py-1 rounded text-xs border flex items-center gap-1 transition-colors",
                                                    (v.stock - (v.reserved || 0)) <= 0 ? "bg-red-500/10 border-red-500/20 text-red-700 dark:text-red-400" :
                                                        (v.stock - (v.reserved || 0)) < 3 ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-700 dark:text-yellow-400" :
                                                            "bg-background border-border hover:bg-muted",
                                                    restockTarget?.id === v.id && "ring-2 ring-primary/40"
                                                )}
                                            >
                                                <span className="font-bold">{v.size}</span>
                                                <span className="text-muted-foreground mx-1">|</span>
                                                <span className={cn((v.stock - (v.reserved || 0)) <= 0 && "font-bold")}>
                                                    {v.stock - (v.reserved || 0)}
                                                </span>
                                                {v.reserved! > 0 && (
                                                    <span className="text-[10px] text-blue-500 ml-1" title="Reservado por ordenes awaiting_payment">
                                                        (R:{v.reserved})
                                                    </span>
                                                )}
                                                <PackagePlus className="w-3 h-3 ml-1 opacity-60" />
                                            </button>
                                        ))}
                                        <button
                                            onClick={() => {
                                                setAddingVariantTo(addingVariantTo === product.id ? null : product.id);
                                                setRestockTarget(null);
                                                setNewVariant({ size: '', stock: '' });
                                            }}
                                            className="px-2 py-1 rounded text-xs border border-dashed border-primary/50 text-primary hover:bg-primary/5 transition-colors"
                                        >
                                            + Talla
                                        </button>
                                    </div>

                                    {/* Reposición de talla existente: solo suma stock */}
                                    {restockTarget && product.variants?.some(v => v.id === restockTarget.id) && (
                                        <div className="mt-2 p-2 bg-muted/30 rounded border border-border flex flex-wrap gap-2 items-center">
                                            <span className="text-xs text-muted-foreground">
                                                Reponer talla <strong>{restockTarget.size}</strong>
                                                {' '}(disponible {restockTarget.stock - (restockTarget.reserved || 0)})
                                            </span>
                                            <input
                                                type="number" min="1" step="1" placeholder="Cantidad"
                                                className="w-24 px-2 py-1 text-xs border rounded bg-background"
                                                value={restockQty}
                                                onChange={e => setRestockQty(e.target.value)}
                                            />
                                            <button
                                                disabled={savingRestock}
                                                onClick={() => handleRestock(restockTarget)}
                                                className="px-3 py-1 bg-primary text-primary-foreground text-xs rounded hover:bg-primary/90 disabled:opacity-60"
                                            >
                                                {savingRestock ? 'Reponiendo...' : 'Reponer'}
                                            </button>
                                            <button
                                                onClick={() => { setRestockTarget(null); setRestockQty(''); }}
                                                className="px-2 py-1 text-xs hover:underline"
                                            >
                                                Cancelar
                                            </button>
                                        </div>
                                    )}

                                    {/* Nueva talla: nunca fusiona ni borra una existente */}
                                    {addingVariantTo === product.id && (
                                        <div className="mt-2 p-2 bg-muted/30 rounded border border-border flex flex-wrap gap-2 items-center">
                                            <span className="text-xs text-muted-foreground">Nueva talla</span>
                                            <input
                                                type="number" min="1" max="60" step="0.5" placeholder="Talla"
                                                className="w-20 px-2 py-1 text-xs border rounded bg-background"
                                                value={newVariant.size} onChange={e => setNewVariant({ ...newVariant, size: e.target.value })}
                                            />
                                            <input
                                                type="number" min="1" step="1" placeholder="Cantidad"
                                                className="w-24 px-2 py-1 text-xs border rounded bg-background"
                                                value={newVariant.stock} onChange={e => setNewVariant({ ...newVariant, stock: e.target.value })}
                                            />
                                            <button
                                                disabled={savingVariant}
                                                onClick={() => handleAddVariant(product.id)}
                                                className="px-3 py-1 bg-primary text-primary-foreground text-xs rounded hover:bg-primary/90 disabled:opacity-60"
                                            >
                                                {savingVariant ? 'Agregando...' : 'Agregar'}
                                            </button>
                                            <button
                                                onClick={() => { setAddingVariantTo(null); setNewVariant({ size: '', stock: '' }); }}
                                                className="px-2 py-1 text-xs hover:underline"
                                            >
                                                Cancelar
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
                                <td className="p-4 font-mono">
                                    {product.default_unit_cost_cents ? (
                                        <div>
                                            ${(product.default_unit_cost_cents / 100).toLocaleString('es-CO')}
                                            {product.price_cents > 0 && (
                                                <div className="text-xs text-muted-foreground">
                                                    {Math.round(((product.price_cents - product.default_unit_cost_cents) / product.price_cents) * 100)}% gross
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <span className="text-xs font-medium text-amber-600">Missing</span>
                                    )}
                                </td>
                                <td className="p-4">
                                    <div className="text-sm">
                                        <span className={cn("font-bold", product.available_stock! <= 0 ? "text-red-500" : "text-green-500")}>
                                            {product.available_stock} Available
                                        </span>
                                        <div className="text-xs text-muted-foreground">
                                            {product.total_stock} Total - {product.committed_stock} Reserved
                                        </div>
                                    </div>
                                </td>
                                <td className="p-4 text-right">
                                    <div className="flex justify-end gap-2">
                                        <button
                                            onClick={() => handleToggleActive(product)}
                                            disabled={togglingActiveId === product.id}
                                            title={product.active ? 'Ocultar de la vitrina y del bot' : 'Volver a ofrecer'}
                                            className={cn(
                                                "p-2 rounded-md hover:bg-muted disabled:opacity-50",
                                                product.active ? "text-green-600" : "text-muted-foreground"
                                            )}
                                        >
                                            <Power className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={() => openModal(product)}
                                            title="Editar producto"
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
                            {modalError && (
                                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
                                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                    <span>{modalError}</span>
                                </div>
                            )}

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
                                        min="1"
                                        step="1"
                                        className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                        value={newProduct.price_cents} onChange={e => setNewProduct({ ...newProduct, price_cents: Number(e.target.value) })}
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium">Unit Cost (COP)</label>
                                <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                    value={newProduct.default_unit_cost_cents}
                                    onChange={e => setNewProduct({ ...newProduct, default_unit_cost_cents: Number(e.target.value) })}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium">Colors</label>
                                <div className="flex flex-wrap gap-2">
                                    {COLOR_ORDER.map(color => {
                                        const selected = newProduct.colors.includes(color);
                                        return (
                                            <button
                                                key={color}
                                                type="button"
                                                onClick={() => setNewProduct(prev => ({
                                                    ...prev,
                                                    colors: selected
                                                        ? prev.colors.filter(c => c !== color)
                                                        : [...prev.colors, color]
                                                }))}
                                                className={cn(
                                                    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-colors",
                                                    selected
                                                        ? "border-primary bg-primary/10 text-foreground"
                                                        : "border-border text-muted-foreground hover:bg-muted"
                                                )}
                                            >
                                                <span
                                                    className="w-3 h-3 rounded-full border border-border"
                                                    style={{ backgroundColor: COLOR_VOCABULARY[color].hex }}
                                                />
                                                {COLOR_VOCABULARY[color].label}
                                            </button>
                                        );
                                    })}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Alimentan el filtro de color de la vitrina. Sin color, el producto no aparece al filtrar.
                                </p>
                            </div>

                            {editingProduct && (
                                <label className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2 text-sm">
                                    <span>
                                        <span className="font-medium">Producto activo</span>
                                        <span className="block text-xs text-muted-foreground">
                                            Si lo desactivas, deja de aparecer en la vitrina y en las consultas del bot.
                                        </span>
                                    </span>
                                    <input
                                        type="checkbox"
                                        className="h-4 w-4"
                                        checked={editingProduct.active}
                                        onChange={(e) => setEditingProduct({ ...editingProduct, active: e.target.checked })}
                                    />
                                </label>
                            )}

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
                                                        onClick={() => handleSetPrimaryImage(m.id)}
                                                        className={cn("p-1 rounded-full", m.is_primary ? "bg-yellow-400 text-black" : "bg-white/20 text-white hover:bg-white/40")}
                                                        title="Set Primary"
                                                    >
                                                        <Star className={cn("w-4 h-4", m.is_primary && "fill-current")} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteImage(m.id, m.storage_path || "")}
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
                                                type="number" min="1" max="60" step="0.5" placeholder="Size (e.g. 40)" className="flex-1 px-3 py-2 rounded-md border border-input bg-background"
                                                value={v.size} onChange={e => {
                                                    const newVars = [...initialVariants];
                                                    newVars[idx].size = e.target.value;
                                                    setInitialVariants(newVars);
                                                }}
                                            />
                                            <input
                                                type="number" min="1" step="1" placeholder="Stock" className="flex-1 px-3 py-2 rounded-md border border-input bg-background"
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
