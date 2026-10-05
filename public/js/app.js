const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => (v == null ? '—' : '₹' + Number(v).toFixed(2));

async function api(url, opts) {
  const r = await fetch('/api' + url, opts && { headers: { 'Content-Type': 'application/json' }, ...opts });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function toast(msg, ok = true) {
  const t = document.createElement('div');
  t.className = `px-4 py-3 rounded shadow text-white ${ok ? 'bg-green-600' : 'bg-red-600'}`;
  t.textContent = msg;
  $('toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}

// ---------- Tabs ----------
function showTab(name) {
  document.querySelectorAll('section[id^="tab-"]').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + name));
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('border-green-600', on);
    b.classList.toggle('text-green-700', on);
    b.classList.toggle('border-transparent', !on);
  });
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------- Data loaders ----------
let crops = [];

async function loadStats() {
  const s = await api('/stats');
  $('stat-crops').textContent = s.active_crops;
  $('stat-alerts').textContent = s.price_alerts;
  $('stat-ship').textContent = s.pending_shipments;
}

async function loadCrops() {
  crops = await api('/crops');
  $('crop-grid').innerHTML = crops.length ? crops.map(c => `
    <div class="bg-white rounded-lg shadow p-4 space-y-1">
      <div class="flex justify-between items-start">
        <h3 class="font-semibold text-lg">${esc(c.Type_name)}</h3>
        <span class="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">${esc(c.category)}</span>
      </div>
      <p class="text-sm text-gray-500">#${c.Crop_id} · ${esc(c.Farmer_name)} · ${esc(c.District)}, ${esc(c.State)}</p>
      <p class="text-sm">Harvested: ${esc(c.Harvest_date)}</p>
      <p class="text-sm">Available: <b>${c.Quantity} kg</b> · Price: <b>${money(c.Price_Per_kg)}/kg</b></p>
      <div class="flex gap-2 pt-2">
        <button data-buy="${c.Crop_id}" class="flex-1 bg-green-700 hover:bg-green-600 text-white text-sm py-2 rounded">Buy Now</button>
        <button data-check="${c.Crop_id}" class="flex-1 border border-green-700 text-green-700 text-sm py-2 rounded hover:bg-green-50">Check Price</button>
      </div>
    </div>`).join('') : '<p class="text-gray-500">No crops available.</p>';
  $('crop-select').innerHTML = crops.map(c => `<option value="${c.Crop_id}">#${c.Crop_id} – ${esc(c.Type_name)} (${esc(c.Farmer_name)})</option>`).join('');
}

async function loadShipments() {
  const rows = await api('/shipments/active');
  $('ship-body').innerHTML = rows.length ? rows.map(s => `
    <tr class="border-t">
      <td class="p-3">#${s.Order_id}</td><td class="p-3">${esc(s.Customer_name)}</td><td class="p-3">${esc(s.Delivery_address)}</td>
      <td class="p-3"><span class="px-2 py-1 rounded text-xs ${s.Shipping_status === 'IN_TRANSIT' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}">${esc(s.Shipping_status)}</span></td>
      <td class="p-3">${esc(s.Estimated_delivery_date ?? '—')}</td><td class="p-3">${esc(s.Provider_name)}</td><td class="p-3">${esc(s.Provider_phone)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="p-4 text-gray-500">No active shipments.</td></tr>';
}

async function loadProviders() {
  const lps = await api('/logistics');
  $('lp-select').innerHTML = lps.map(l => `<option value="${l.LP_id}">${esc(l.Provider_name)}</option>`).join('');
}

const loadAll = () => Promise.all([loadStats(), loadCrops(), loadShipments(), loadProviders()])
  .catch(e => toast(e.message, false));

// ---------- Decision panel ----------
async function analyze() {
  const id = $('crop-select').value;
  if (!id) return toast('Select a crop first', false);
  try {
    const d = await api('/price-decision/' + id);
    const sell = d.recommendation === 'SELL NOW';
    $('decision-result').innerHTML = `
      <span class="inline-block px-4 py-2 rounded-full font-bold text-white ${sell ? 'bg-red-600' : 'bg-green-600'}">${esc(d.recommendation)}</span>
      <div class="grid grid-cols-3 gap-3 mt-4 text-center">
        <div class="bg-gray-100 rounded p-3"><p class="text-xs text-gray-500">Current</p><p class="font-bold">${money(d.current_price)}</p></div>
        <div class="bg-gray-100 rounded p-3"><p class="text-xs text-gray-500">Historical avg</p><p class="font-bold">${money(d.historical_avg)}</p></div>
        <div class="bg-gray-100 rounded p-3"><p class="text-xs text-gray-500">Predicted</p><p class="font-bold">${money(d.predicted_price)}</p></div>
      </div>`;
  } catch (e) {
    $('decision-result').innerHTML = '';
    toast(e.message, false);
  }
}
$('analyze').onclick = analyze;

// ---------- Marketplace buttons (event delegation) ----------
let orderCrop = null;
$('crop-grid').onclick = e => {
  const buy = e.target.closest('[data-buy]'), check = e.target.closest('[data-check]');
  if (check) { $('crop-select').value = check.dataset.check; showTab('decision'); analyze(); }
  if (buy) {
    orderCrop = crops.find(c => c.Crop_id == buy.dataset.buy);
    $('order-info').textContent = `${orderCrop.Type_name} · ${money(orderCrop.Price_Per_kg)}/kg · ${orderCrop.Quantity} kg available`;
    $('order-form').quantity.max = orderCrop.Quantity;
    $('modal').classList.replace('hidden', 'flex');
  }
};

// ---------- Order form ----------
const closeModal = () => $('modal').classList.replace('flex', 'hidden');
$('cancel').onclick = closeModal;
$('order-form').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const { quantity, payment_mode, lp_id, ...customer } = f;
  try {
    const r = await api('/orders', { method: 'POST', body: JSON.stringify({ customer, crop_id: orderCrop.Crop_id, quantity, payment_mode, lp_id }) });
    toast(`Order #${r.order_id} placed – total ${money(r.total)}`);
    e.target.reset();
    closeModal();
    loadAll();
  } catch (err) {
    toast(err.message, false);
  }
};

$('refresh').onclick = () => loadAll().then(() => toast('Refreshed'));
showTab('market');
loadAll();
