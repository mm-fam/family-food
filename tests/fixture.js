// A tiny household for smoke tests. Same tab headers as the live Sheet; made-up people and items.
'use strict';
const H = {
  Items: ['id', 'name', 'store', 'group', 'brand_size', 'ok_swap', 'status', 'aliases', 'notes', 'orders', 'first_bought', 'last_bought', 'avg_days', 'shelf_days', 'open_to_try', 'best_price'],
  List: ['id', 'item_id', 'name', 'store', 'qty', 'note', 'added_by', 'added_at', 'status', 'updated_at', 'meal_id', 'hold_until', 'wanted_by', 'cart', 'cart_at', 'cart_want', 'cart_by', 'cart_note'],
  'List Archive': ['id', 'item_id', 'name', 'store', 'qty', 'note', 'added_by', 'added_at', 'status', 'updated_at', 'meal_id', 'hold_until', 'wanted_by', 'cart', 'cart_at'],
  Meals: ['id', 'name', 'item_ids', 'notes', 'kind', 'meat_qty', 'feature'],
  Plan: ['week_of', 'day', 'meal_id', 'date', 'slot', 'note', 'item_id'],
  'Plan Archive': ['week_of', 'day', 'meal_id', 'date', 'slot', 'note', 'item_id'],
  Receipts: ['date', 'store', 'order_ref', 'raw', 'item_id', 'qty', 'price', 'match'],
  Review: ['id', 'created', 'type', 'detail', 'status', 'answer', 'audience', 'passed_by', 'asked_by', 'later_count', 'later_at', 'outcome', 'answered_at', 'points', 'points_to', 'points_why', 'due_at'],
  Settings: ['key', 'value'],
  Stock: ['at', 'item_id', 'level', 'expires', 'who', 'source', 'list_id'],
  Profile: ['person', 'topic', 'answer', 'review_id', 'at'],
  Products: ['item_id', 'store', 'product', 'size', 'last_bought', 'match', 'source', 'notes', 'sku', 'aisle', 'price', 'unit_price', 'unit', 'price_at', 'store_brand', 'pack'],
  Points: ['at', 'to', 'pts', 'why', 'ref', 'by', 'note'],
  'Cart Jobs': ['id', 'at', 'by', 'store', 'kind', 'status', 'started_at', 'finished_at', 'result', 'notes', 'subtotal', 'lines'],
  'Meal Ideas': ['id', 'at', 'who', 'text', 'status', 'meal_id', 'notes'],
  'App Feedback': ['id', 'at', 'who', 'tab', 'text', 'status', 'notes'],
};
function item(id, name, store, group, extra) {
  const o = Object.assign({ id: id, name: name, store: store, group: group, status: 'Always' }, extra || {});
  return H.Items.map((h) => (o[h] === undefined ? '' : o[h]));
}
function tabs() {
  const t = {};
  Object.keys(H).forEach((k) => (t[k] = [H[k].slice()]));
  t.Settings.push(['parents', 'Pat,Sam'], ['kids', 'Kim,Lee'], ['admins', 'Pat,Sam'], ['points_start', '2026-11-02']);
  t.Items.push(
    item('i001', 'Bananas', 'Either', 'Produce'),
    item('i002', 'Fairlife whole milk', 'GE', 'Dairy', { aliases: 'FAIRLIFE MILK WHOLAC' }),
    item('i003', 'Chocolate milk', 'GE', 'Dairy'),
    item('i004', 'Brown sugar', 'Either', 'Pantry', { status: 'Sometimes' }),
    item('i005', 'Salted butter', 'GE', 'Dairy'),
    item('i006', 'Bacon (raw)', 'WF', 'Meat', { aliases: 'Organic Pork Bacon No Sugar Added, 8 OZ' }),
  );
  t.Products.push(['i002', 'GE', 'fairlife Whole Ultra-Filtered Milk', '52 fl oz', '', 'exact', 'test', '', "'00000000000001", 'Aisle 17 Dairy', 4.99, 0.096, 'fl oz', "'2026-11-02", '', '']);
  t.Meals.push(['m01', 'Pancakes', 'i002;i005', '', 'breakfast', '', '']);
  return t;
}
module.exports = { tabs, H };
