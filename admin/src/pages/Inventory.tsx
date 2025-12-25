import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Plus, Edit, Trash2 } from "lucide-react";

type Product = {
    id: string;
    sku: string;
    brand: string;
    model: string;
    category: string;
    price_cents: number;
    description: string;
};

export default function Inventory() {
    const [products, setProducts] = useState<Product[]>([]);

    useEffect(() => {
        fetchProducts();
    }, []);

    async function fetchProducts() {
        const { data: productsData } = await supabase
            .from("products")
            .select("*")
            .order("created_at", { ascending: false });

        if (productsData) {
            setProducts(productsData as Product[]);
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-3xl font-bold tracking-tight">Inventory</h2>
                <button className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90">
                    <Plus className="w-4 h-4" />
                    Add Product
                </button>
            </div>

            <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                        <tr>
                            <th className="px-6 py-3">Product Name</th>
                            <th className="px-6 py-3">Category</th>
                            <th className="px-6 py-3 text-right">Price</th>
                            <th className="px-6 py-3 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {products.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-6 py-4 text-center text-muted-foreground">No products found</td>
                            </tr>
                        ) : (
                            products.map((product) => (
                                <tr key={product.id} className="bg-background border-b border-border hover:bg-muted/50">
                                    <td className="px-6 py-4 font-medium">
                                        <div className="flex flex-col">
                                            <span>{product.brand} {product.model}</span>
                                            <span className="text-xs text-muted-foreground">{product.sku}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">{product.category}</td>
                                    <td className="px-6 py-4 text-right">
                                        ${(product.price_cents / 100).toLocaleString('es-CO')}
                                    </td>
                                    <td className="px-6 py-4 text-center flex justify-center gap-2">
                                        <button className="text-blue-500 hover:text-blue-600">
                                            <Edit className="w-4 h-4" />
                                        </button>
                                        <button className="text-destructive hover:text-destructive/80">
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

