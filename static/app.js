'use strict';

const App = (() => {

  const state = {
    currentTab:        'receipt',
    selectedReceipt:   -1,
    selectedLabel:     -1,
    editingReceiptIdx: null,
    editingLabelIdx:   null,

    receiptItems: [
      { type: 'text', text: 'GPrinter Shop', align: 'center', bold: true,  double_width: true,  double_height: true  },
      { type: 'separator' },
      { type: 'text', text: 'Item A', right_text: '$10.00', align: 'left', bold: false, double_width: false, double_height: false },
      { type: 'separator' },
      { type: 'text', text: 'Thank you!', align: 'center', bold: true,  double_width: false, double_height: false },
      { type: 'feed', lines: 4 }
    ],

    labelElements: [
      { type: 'text',    text: 'PRODUCT LABEL', x: 40, y: 20,  font: '3', rotation: 0, mx: 1, my: 1 },
      { type: 'barcode', content: '12345678',   x: 40, y: 80,  btype: '128', height: 60, readable: 1, rotation: 0, narrow: 2, wide: 6 },
      { type: 'qrcode',  content: 'https://GPrinter.example', x: 280, y: 180, cell_width: 4, rotation: 0, ecc: 'M' }
    ],

    pdfFile: null,
    pdfTotalPages: 0
  };

  function $(id) { return document.getElementById(id); }

  function toast(msg, type = 'ok', ms = 3000) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'show ' + type;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, ms);
  }

  function getConn() {
    const mode = $('conn-mode').value;
    return {
      mode,
      ip:          $('eth-ip').value.trim(),
      print_port:  parseInt($('eth-print-port').value) || 9100,
      status_port: parseInt($('eth-status-port').value) || 4000,
      path:        $('usb-device').value
    };
  }

  function getPrintSettings() {
    return {
      target_width:   parseInt($('print-width').value) || 576,
      chars_per_line: parseInt($('chars-per-line').value) || 48,
      left_margin:    parseInt($('left-margin').value) || 0,
      autocut:        $('autocut-chk').checked
    };
  }

  async function api(endpoint, opts = {}) {
    try {
      const res = await fetch(endpoint, opts);
      return await res.json();
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async function apiPost(endpoint, body) {
    return api(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
  }

  function onModeChange() {
    const mode = $('conn-mode').value;
    $('eth-fields').style.display = mode === 'ethernet' ? '' : 'none';
    $('usb-fields').style.display = mode === 'usb'      ? '' : 'none';
    stopStatusPoll();
    if (mode === 'ethernet') startStatusPoll();
  }

  async function refreshUsb() {
    const sel = $('usb-device');
    sel.innerHTML = '<option>Loading…</option>';
    const r = await api('/api/printers/usb');
    sel.innerHTML = '';
    if (r.devices && r.devices.length > 0) {
      r.devices.forEach(d => {
        const o = document.createElement('option');
        o.value = o.textContent = d;
        sel.appendChild(o);
      });
    } else {
      sel.innerHTML = '<option value="">No USB printers found</option>';
    }
  }

  async function scanLan() {
    const btn = event.target;
    btn.textContent = 'Scanning…';
    btn.disabled = true;
    const r = await api('/api/printers/scan');
    btn.textContent = 'Scan LAN';
    btn.disabled = false;
    const sel = $('lan-results');
    sel.innerHTML = '<option value="">— Results —</option>';
    if (r.printers && r.printers.length > 0) {
      r.printers.forEach(p => {
        const o = document.createElement('option');
        o.value = p.ip;
        o.textContent = `${p.ip} (${p.name})`;
        sel.appendChild(o);
      });
      toast(`Found ${r.printers.length} printer(s)`, 'ok');
    } else {
      toast('No printers found on LAN', 'err');
    }
  }

  function onLanSelect() {
    const ip = $('lan-results').value;
    if (ip) $('eth-ip').value = ip;
  }

  async function testConnection() {
    const conn = getConn();
    const r = await apiPost('/api/printer/test', { ...conn, port: conn.print_port });
    toast(r.message || r.error || (r.success ? 'OK' : 'Failed'), r.success ? 'ok' : 'err');
    if (r.success) updateStatusPill({ success: true, online: true, error_msg: 'Ready' });
  }

  let _statusInterval = null;

  function startStatusPoll() {
    if (_statusInterval) return;
    _statusInterval = setInterval(async () => {
      const conn = getConn();
      if (conn.mode !== 'ethernet' || !conn.ip) return;
      const r = await apiPost('/api/printer/status', { ip: conn.ip, status_port: conn.status_port });
      updateStatusPill(r);
    }, 5000);
  }

  function stopStatusPoll() {
    clearInterval(_statusInterval);
    _statusInterval = null;
    updateStatusPill(null);
  }

  function updateStatusPill(status) {
    const pill = $('status-pill');
    if (!status) { pill.textContent = 'Not connected'; pill.className = ''; return; }
    if (!status.success) {
      pill.textContent = status.error_msg || 'Connection failed';
      pill.className = 'error'; return;
    }
    if (status.paper_out || status.cover_open || status.cutter_error) {
      pill.textContent = status.error_msg || 'Printer Error';
      pill.className = 'error'; return;
    }
    if (status.paper_near_end) {
      pill.textContent = 'Paper Near End';
      pill.className = 'warn'; return;
    }
    pill.textContent = `Printer Ready (${$('eth-ip').value})`;
    pill.className = 'ready';
  }

  function switchTab(name) {
    state.currentTab = name;
    ['receipt', 'label', 'pdf'].forEach(t => {
      $(`tab-btn-${t}`).classList.toggle('active', t === name);
      $(`tab-${t}`).classList.toggle('active', t === name);
    });
  }

  function printCurrent() {
    print(state.currentTab === 'label' ? 'tspl' : state.currentTab === 'pdf' ? 'pdf' : 'escpos');
  }

  function spin(id, delta, min) {
    const el = $(id);
    let v = parseInt(el.value) + delta;
    if (min !== undefined) v = Math.max(min, v);
    if (el.min !== '') v = Math.max(parseInt(el.min), v);
    if (el.max !== '') v = Math.min(parseInt(el.max), v);
    el.value = v;
    el.dispatchEvent(new Event('input'));
  }

  function openModal(id) { $(id).classList.add('open'); }
  function closeModal(id) { $(id).classList.remove('open'); }

  document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.remove('open');
    }
  });

  function itemDetail(it) {
    switch (it.type) {
      case 'text':      return (it.right_text ? `${it.text} | ${it.right_text}` : it.text) || '';
      case 'separator': return '────────────────────';
      case 'feed':      return `${it.lines} line(s)`;
      case 'image':     return '<Image>';
      default:          return '';
    }
  }

  function renderReceiptTable() {
    const tbody = $('receipt-tbody');
    tbody.innerHTML = '';
    state.receiptItems.forEach((it, i) => {
      const tr = document.createElement('tr');
      if (i === state.selectedReceipt) tr.classList.add('selected');
      tr.innerHTML = `<td>${it.type}</td><td>${itemDetail(it)}</td>`;
      tr.onclick = () => { state.selectedReceipt = i; renderReceiptTable(); };
      tbody.appendChild(tr);
    });
    refreshReceiptPreview();
  }

  async function refreshReceiptPreview() {
    if (state.receiptItems.length === 0) {
      $('receipt-preview-area').innerHTML = '<span class="preview-placeholder">Add items to see preview</span>';
      return;
    }
    const ps = getPrintSettings();
    const r  = await apiPost('/api/preview/escpos', {
      items:          state.receiptItems,
      target_width:   ps.target_width,
      chars_per_line: ps.chars_per_line,
      left_margin:    ps.left_margin
    });
    if (r.success) {
      $('receipt-preview-area').innerHTML = `<img src="${r.preview}" alt="Receipt Preview"/>`;
      $('receipt-preview-info').textContent = `${ps.target_width} dots`;
    } else {
      toast('Preview error: ' + (r.error || '?'), 'err');
    }
  }

  function addReceiptItem(type) {
    state.editingReceiptIdx = null;
    if (type === 'separator') {
      state.receiptItems.push({ type: 'separator' });
      renderReceiptTable();
      return;
    }
    if (type === 'feed') {
      $('rf-lines').value = 3;
      openModal('modal-receipt-feed');
      return;
    }
    $('modal-receipt-text-title').textContent = 'Add Text Item';
    $('rt-text').value = '';
    $('rt-right-text').value = '';
    $('rt-align').value = 'left';
    $('rt-bold').checked = false;
    $('rt-dw').checked = false;
    $('rt-dh').checked = false;
    openModal('modal-receipt-text');
  }

  function editReceiptItem() {
    const i = state.selectedReceipt;
    if (i < 0 || i >= state.receiptItems.length) return;
    const it = state.receiptItems[i];
    state.editingReceiptIdx = i;
    if (it.type === 'text') {
      $('modal-receipt-text-title').textContent = 'Edit Text Item';
      $('rt-text').value       = it.text || '';
      $('rt-right-text').value = it.right_text || '';
      $('rt-align').value      = it.align || 'left';
      $('rt-bold').checked     = !!it.bold;
      $('rt-dw').checked       = !!it.double_width;
      $('rt-dh').checked       = !!it.double_height;
      openModal('modal-receipt-text');
    } else if (it.type === 'feed') {
      $('rf-lines').value = it.lines || 3;
      openModal('modal-receipt-feed');
    }
  }

  function saveReceiptText() {
    const it = {
      type:          'text',
      text:          $('rt-text').value,
      right_text:    $('rt-right-text').value,
      align:         $('rt-align').value,
      bold:          $('rt-bold').checked,
      double_width:  $('rt-dw').checked,
      double_height: $('rt-dh').checked
    };
    if (state.editingReceiptIdx !== null) {
      state.receiptItems[state.editingReceiptIdx] = it;
    } else {
      state.receiptItems.push(it);
    }
    closeModal('modal-receipt-text');
    renderReceiptTable();
  }

  function saveReceiptFeed() {
    const it = { type: 'feed', lines: parseInt($('rf-lines').value) || 1 };
    if (state.editingReceiptIdx !== null) {
      state.receiptItems[state.editingReceiptIdx] = it;
    } else {
      state.receiptItems.push(it);
    }
    closeModal('modal-receipt-feed');
    renderReceiptTable();
  }

  function deleteReceiptItem() {
    const i = state.selectedReceipt;
    if (i < 0 || i >= state.receiptItems.length) return;
    state.receiptItems.splice(i, 1);
    state.selectedReceipt = Math.min(i, state.receiptItems.length - 1);
    renderReceiptTable();
  }

  function moveReceiptItem(dir) {
    const i = state.selectedReceipt;
    const arr = state.receiptItems;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    state.selectedReceipt = j;
    renderReceiptTable();
  }

  function labelElDetail(el) {
    switch (el.type) {
      case 'text':    return `(${el.x},${el.y}) "${el.text}"`;
      case 'barcode': return `(${el.x},${el.y}) [${el.btype}] ${el.content}`;
      case 'qrcode':  return `(${el.x},${el.y}) ${el.content}`;
      case 'image':   return `(${el.x},${el.y}) <Image>`;
      default:        return '';
    }
  }

  function renderLabelTable() {
    const tbody = $('label-tbody');
    tbody.innerHTML = '';
    state.labelElements.forEach((el, i) => {
      const tr = document.createElement('tr');
      if (i === state.selectedLabel) tr.classList.add('selected');
      tr.innerHTML = `<td>${el.type}</td><td>${labelElDetail(el)}</td>`;
      tr.onclick = () => { state.selectedLabel = i; renderLabelTable(); };
      tbody.appendChild(tr);
    });
    refreshLabelPreview();
  }

  async function refreshLabelPreview() {
    const w = parseFloat($('lbl-w').value) || 50;
    const h = parseFloat($('lbl-h').value) || 40;
    const g = parseFloat($('lbl-gap').value) || 2;
    $('label-preview-info').textContent = `${w}×${h} mm`;

    const els = state.labelElements.map(el => {
      const { image, ...rest } = el;
      return rest;
    });

    if (els.length === 0) {
      $('label-preview-area').innerHTML = '<span class="preview-placeholder">Add elements to see preview</span>';
      return;
    }
    const r = await apiPost('/api/preview/tspl', { width_mm: w, height_mm: h, gap_mm: g, elements: els });
    if (r.success) {
      $('label-preview-area').innerHTML = `<img src="${r.preview}" alt="Label Preview"/>`;
    } else {
      toast('Preview error: ' + (r.error || '?'), 'err');
    }
  }

  function addLabelEl(type) {
    state.editingLabelIdx = null;
    if (type === 'text') {
      $('modal-label-text-title').textContent = 'Add Label Text';
      $('lt-text').value = 'Label Text';
      $('lt-x').value = 40; $('lt-y').value = 20;
      $('lt-font').value = '3';
      $('lt-rot').value = '0';
      $('lt-mx').value = 1; $('lt-my').value = 1;
      openModal('modal-label-text');
    } else if (type === 'barcode') {
      $('modal-label-barcode-title').textContent = 'Add Barcode';
      $('lb-content').value = '12345678';
      $('lb-x').value = 40; $('lb-y').value = 80;
      $('lb-type').value = '128';
      $('lb-h').value = 60;
      $('lb-readable').value = '1';
      openModal('modal-label-barcode');
    } else if (type === 'qrcode') {
      $('modal-label-qr-title').textContent = 'Add QR Code';
      $('lq-content').value = 'https://example.com';
      $('lq-x').value = 40; $('lq-y').value = 40;
      $('lq-cell').value = 4;
      $('lq-ecc').value = 'M';
      openModal('modal-label-qr');
    }
  }

  function editLabelEl() {
    const i = state.selectedLabel;
    if (i < 0 || i >= state.labelElements.length) return;
    const el = state.labelElements[i];
    state.editingLabelIdx = i;
    if (el.type === 'text') {
      $('modal-label-text-title').textContent = 'Edit Label Text';
      $('lt-text').value  = el.text || '';
      $('lt-x').value     = el.x || 0;
      $('lt-y').value     = el.y || 0;
      $('lt-font').value  = el.font || '3';
      $('lt-rot').value   = String(el.rotation || 0);
      $('lt-mx').value    = el.mx || 1;
      $('lt-my').value    = el.my || 1;
      openModal('modal-label-text');
    } else if (el.type === 'barcode') {
      $('modal-label-barcode-title').textContent = 'Edit Barcode';
      $('lb-content').value  = el.content || '';
      $('lb-x').value        = el.x || 0;
      $('lb-y').value        = el.y || 0;
      $('lb-type').value     = el.btype || '128';
      $('lb-h').value        = el.height || 60;
      $('lb-readable').value = String(el.readable ?? 1);
      openModal('modal-label-barcode');
    } else if (el.type === 'qrcode') {
      $('modal-label-qr-title').textContent = 'Edit QR Code';
      $('lq-content').value = el.content || '';
      $('lq-x').value       = el.x || 0;
      $('lq-y').value       = el.y || 0;
      $('lq-cell').value    = el.cell_width || 4;
      $('lq-ecc').value     = el.ecc || 'M';
      openModal('modal-label-qr');
    }
  }

  function saveLabelText() {
    const el = {
      type:     'text',
      text:     $('lt-text').value,
      x:        parseInt($('lt-x').value) || 0,
      y:        parseInt($('lt-y').value) || 0,
      font:     $('lt-font').value,
      rotation: parseInt($('lt-rot').value) || 0,
      mx:       parseInt($('lt-mx').value) || 1,
      my:       parseInt($('lt-my').value) || 1
    };
    _saveLabelEl(el, 'modal-label-text');
  }

  function saveLabelBarcode() {
    const el = {
      type:     'barcode',
      content:  $('lb-content').value,
      x:        parseInt($('lb-x').value) || 0,
      y:        parseInt($('lb-y').value) || 0,
      btype:    $('lb-type').value,
      height:   parseInt($('lb-h').value) || 60,
      readable: parseInt($('lb-readable').value),
      rotation: 0, narrow: 2, wide: 6
    };
    _saveLabelEl(el, 'modal-label-barcode');
  }

  function saveLabelQr() {
    const el = {
      type:       'qrcode',
      content:    $('lq-content').value,
      x:          parseInt($('lq-x').value) || 0,
      y:          parseInt($('lq-y').value) || 0,
      cell_width: parseInt($('lq-cell').value) || 4,
      ecc:        $('lq-ecc').value,
      rotation:   0
    };
    _saveLabelEl(el, 'modal-label-qr');
  }

  function _saveLabelEl(el, modalId) {
    if (state.editingLabelIdx !== null) {
      state.labelElements[state.editingLabelIdx] = el;
    } else {
      state.labelElements.push(el);
    }
    closeModal(modalId);
    renderLabelTable();
  }

  function deleteLabelEl() {
    const i = state.selectedLabel;
    if (i < 0 || i >= state.labelElements.length) return;
    state.labelElements.splice(i, 1);
    state.selectedLabel = Math.min(i, state.labelElements.length - 1);
    renderLabelTable();
  }

  function moveLabelEl(dir) {
    const i = state.selectedLabel;
    const arr = state.labelElements;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    state.selectedLabel = j;
    renderLabelTable();
  }

  function importBin(kind) {
    $(`import-${kind}-file`).value = '';
    $(`import-${kind}-file`).click();
  }

  async function onImportFile(kind) {
    const input = $(`import-${kind}-file`);
    if (!input.files.length) return;
    const fd = new FormData();
    fd.append('file', input.files[0]);
    const r = await api(`/api/import/${kind}`, { method: 'POST', body: fd });
    if (!r.success) { toast('Import failed: ' + (r.error || '?'), 'err'); return; }
    if (kind === 'escpos') {
      state.receiptItems = r.items || [];
      renderReceiptTable();
      toast('ESC/POS .bin imported', 'ok');
    } else {
      state.labelElements = r.elements || [];
      if (r.width_mm)  $('lbl-w').value  = r.width_mm;
      if (r.height_mm) $('lbl-h').value  = r.height_mm;
      if (r.gap_mm)    $('lbl-gap').value = r.gap_mm;
      renderLabelTable();
      toast('TSPL .bin imported', 'ok');
    }
  }

  async function exportBin(kind) {
    const ps  = getPrintSettings();
    let url, body;
    if (kind === 'escpos') {
      url  = '/api/export/escpos';
      body = {
        items:          state.receiptItems,
        target_width:   ps.target_width,
        chars_per_line: ps.chars_per_line,
        left_margin:    ps.left_margin,
        autocut:        ps.autocut
      };
    } else {
      url  = '/api/export/tspl';
      const els = state.labelElements.map(({ image, ...rest }) => rest);
      body = {
        elements:  els,
        width_mm:  parseFloat($('lbl-w').value) || 50,
        height_mm: parseFloat($('lbl-h').value) || 40,
        gap_mm:    parseFloat($('lbl-gap').value) || 2,
        autocut:   $('autocut-chk').checked
      };
    }
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    if (!res.ok) { toast('Export failed', 'err'); return; }
    const blob = await res.blob();
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = kind === 'escpos' ? 'receipt.bin' : 'label.bin';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${a.download}`, 'ok');
  }

  async function onPdfSelected() {
    const input = $('pdf-file-input');
    if (!input.files.length) return;
    state.pdfFile = input.files[0];
    $('pdf-filename').textContent = state.pdfFile.name;
    $('pdf-page').value = 0;
    await loadPdfPreview();
  }

  async function loadPdfPreview() {
    if (!state.pdfFile) return;
    const fd = new FormData();
    fd.append('file', state.pdfFile);
    fd.append('page', $('pdf-page').value);
    const r = await api('/api/preview/pdf', { method: 'POST', body: fd });
    if (r.success) {
      state.pdfTotalPages = r.total_pages;
      $('pdf-total-pages').textContent = `/ ${r.total_pages} pages`;
      $('pdf-page').max = r.total_pages - 1;
      $('pdf-preview-area').innerHTML = `<img src="${r.preview}" alt="PDF Preview"/>`;
    } else {
      toast('PDF preview error: ' + (r.error || '?'), 'err');
    }
  }

  async function print(kind) {
    const conn = getConn();
    const ps   = getPrintSettings();
    let r;

    if (kind === 'escpos') {
      r = await apiPost('/api/print/escpos', {
        ...conn,
        items:          state.receiptItems,
        target_width:   ps.target_width,
        chars_per_line: ps.chars_per_line,
        left_margin:    ps.left_margin,
        autocut:        ps.autocut
      });
    } else if (kind === 'tspl') {
      const els = state.labelElements.map(({ image, ...rest }) => rest);
      r = await apiPost('/api/print/tspl', {
        ...conn,
        elements:  els,
        width_mm:  parseFloat($('lbl-w').value) || 50,
        height_mm: parseFloat($('lbl-h').value) || 40,
        gap_mm:    parseFloat($('lbl-gap').value) || 2,
        autocut:   $('autocut-chk').checked
      });
    } else if (kind === 'pdf') {
      if (!state.pdfFile) { toast('No PDF selected', 'err'); return; }
      const fd = new FormData();
      fd.append('file',         state.pdfFile);
      fd.append('page',         $('pdf-page').value);
      fd.append('target_width', ps.target_width);
      fd.append('mode',         conn.mode);
      fd.append('ip',           conn.ip);
      fd.append('print_port',   conn.print_port);
      fd.append('status_port',  conn.status_port);
      fd.append('path',         conn.path);
      r = await api('/api/print/pdf', { method: 'POST', body: fd });
    }

    if (r && r.success) {
      toast('Sent to printer ✓', 'ok');
    } else {
      toast('Print failed: ' + (r && r.error ? r.error : 'Unknown error'), 'err', 5000);
    }
  }

  function initDropZone() {
    const dz = $('pdf-drop-zone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith('.pdf')) {
        state.pdfFile = file;
        $('pdf-filename').textContent = file.name;
        $('pdf-page').value = 0;
        loadPdfPreview();
      }
    });
  }

  function initLiveRefresh() {
    ['print-width', 'chars-per-line', 'left-margin'].forEach(id => {
      $(id).addEventListener('change', () => {
        if (state.currentTab === 'receipt') refreshReceiptPreview();
      });
    });
  }

  function init() {
    renderReceiptTable();
    renderLabelTable();
    onModeChange();
    initDropZone();
    initLiveRefresh();
    startStatusPoll();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    onModeChange, refreshUsb, scanLan, onLanSelect, testConnection,
    switchTab, printCurrent,
    spin: (id, delta, min) => { spin(id, delta, min); if (id === 'pdf-page') loadPdfPreview(); },
    openModal, closeModal,
    addReceiptItem, editReceiptItem, deleteReceiptItem, moveReceiptItem,
    saveReceiptText, saveReceiptFeed, refreshReceiptPreview,
    addLabelEl, editLabelEl, deleteLabelEl, moveLabelEl,
    saveLabelText, saveLabelBarcode, saveLabelQr, refreshLabelPreview,
    importBin, exportBin, onImportFile,
    onPdfSelected,
    print
  };
})();
