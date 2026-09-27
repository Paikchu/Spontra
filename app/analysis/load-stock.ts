"use server";
import { loadStock as load } from "@/lib/stock-context";
export async function loadStock(ticker: string) { return load(ticker); }
