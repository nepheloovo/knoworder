import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, errorMessage } from '../../api/client';
import { useToast } from '../../components/ui';

export const api = <T,>(path: string) => apiFetch<T>(`/commerce${path}`);
export const send = <T,>(path: string, body?: unknown, method = 'POST') => apiFetch<T>(`/commerce${path}`, { method, body: JSON.stringify(body ?? {}) });

/** 读取接口数据；interval 大于 0 时轮询（后台刷新不清空已有内容）。 */
export function useData<T>(path: string, interval = 0) {
  const toast = useToast();
  const [data, setData] = useState<T | null>(null);
  const latest = useRef(path);
  latest.current = path;
  const reload = useCallback(async () => {
    try {
      const loaded = await api<T>(path);
      if (latest.current === path) setData(loaded);
    } catch (caught) {
      if (!interval) toast(errorMessage(caught), 'error');
    }
  }, [path, interval, toast]);
  useEffect(() => {
    void reload();
    if (!interval) return undefined;
    const timer = window.setInterval(() => void reload(), interval);
    return () => window.clearInterval(timer);
  }, [reload, interval]);
  return { data, reload, setData };
}

/** 执行一次操作：成功提示并刷新，失败显示接口返回的原因。返回是否成功。 */
export function useAction(after?: () => unknown) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      if (done) toast(done);
      await after?.();
      return true;
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [after, toast]);
  return { busy, run };
}

export const money = (value: number) => `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

export type Shop = { id: string; name: string; platform: string };
export type Customer = { id: string; name: string; phone: string; level: string; address: string };
export type OrderItem = { sku_id: string; code: string; name: string; quantity: number; price: number };
export type Shipment = { carrier: string; tracking_no: string; status: string; events: Array<{ at: string; text: string }> };
export type Order = {
  id: string; order_no: string; status: string; status_label: string; total: number; refunded: number; address: string; note: string; shop: string; platform: string;
  customer_id: string; customer: string; customer_level: string; created_at: string; shipped_at: string | null; delivered_at: string | null; items: OrderItem[]; shipment: Shipment | null;
};
export type SkuRow = { id: string; code: string; spec: string; price: number; low_stock_threshold: number };
export type Product = { id: string; name: string; category: string; description: string; is_active: boolean; skus: SkuRow[] };
export type AfterSale = { id: string; after_sale_no: string; order_id: string; order_no: string; customer: string; kind: string; kind_label: string; status: string; status_label: string; reason: string; amount: number; source: string; result_note: string; created_at: string };
export type Place = { id: string; code: string; zone: string; kind: string };
export type WarehouseRow = { id: string; code: string; name: string; address: string; locations: Place[] };
export type StockRow = {
  sku_id: string; code: string; name: string; on_hand: number; locked: number; available: number; damaged: number; threshold: number; low: boolean;
  locations: Array<{ location_id: string; location: string; kind: string; warehouse: string; on_hand: number; locked: number; damaged: number }>;
};
export type Move = { id: string; code: string; name: string; location: string; kind: string; kind_label: string; on_hand_delta: number; locked_delta: number; damaged_delta: number; on_hand_after: number; ref_no: string; note: string; created_at: string };
export type Inbound = { id: string; inbound_no: string; warehouse_id: string; warehouse: string; supplier: string; status: string; note: string; created_at: string; lines: Array<{ id: string; code: string; name: string; expected: number; received: number; location: string | null }> };
export type Outbound = { id: string; outbound_no: string; order_no: string; customer: string; warehouse: string; status: string; created_at: string; lines: Array<{ code: string; name: string; location: string; quantity: number }> };
export type ChatMessage = { id: string; role: 'user' | 'assistant' | 'agent' | 'system'; content: string; citations: Array<{ filename?: string }>; simulated: boolean; created_at: string };
export type SessionSummary = { id: string; customer_id: string; customer: string; level: string; status: string; assignee: string; handoff_reason: string; summary: string; was_handed_off: boolean; queued_at: string | null; accepted_at: string | null; updated_at: string; last_message: string };
export type SessionDetail = SessionSummary & { messages: ChatMessage[]; orders?: Order[] };

export const ORDER_TONE: Record<string, string> = { paid: 'orange', picking: 'blue', shipped: 'purple', delivered: 'green', refunded: 'red', cancelled: '' };
export const AFTER_SALE_TONE: Record<string, string> = { requested: 'orange', approved: 'blue', returning: 'purple', completed: 'green', rejected: 'red' };
export const SESSION_LABEL: Record<string, [string, string]> = { ai: ['机器人接待', 'teal'], queued: ['排队中', 'orange'], serving: ['人工接待中', 'blue'], closed: ['已结束', ''] };
