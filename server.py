import sys
import os

DESKTOP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'gprinter-linux-desktop'))
if DESKTOP_DIR not in sys.path:
    sys.path.insert(0, DESKTOP_DIR)

import printer_comm
import escpos_gen
import tspl_gen

import base64
import io
from PIL import Image as PILImage, ImageDraw, ImageFont

from flask import Flask, request, jsonify, send_from_directory, send_file

app = Flask(__name__, static_folder='static', static_url_path='/static')


@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/api/printers/usb')
def list_usb():
    devices = printer_comm.detect_printers()
    return jsonify({'devices': devices})


@app.route('/api/printers/scan')
def scan_lan():
    results = printer_comm.scan_lan_printers()
    return jsonify({'printers': [{'ip': ip, 'name': name} for ip, name in results]})


@app.route('/api/printer/test', methods=['POST'])
def test_connection():
    data = request.get_json(force=True)
    mode = data.get('mode', 'ethernet')
    if mode == 'usb':
        path = data.get('path', '')
        if not os.path.exists(path):
            return jsonify({'success': False, 'message': f'Device not found: {path}'})
        return jsonify({'success': True, 'message': f'USB device reachable: {path}'})
    else:
        ip = data.get('ip', '')
        port = int(data.get('port', 9100))
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(2.0)
            s.connect((ip, port))
            s.close()
            return jsonify({'success': True, 'message': f'Connected to {ip}:{port}'})
        except Exception as e:
            return jsonify({'success': False, 'message': str(e)})


@app.route('/api/printer/status', methods=['POST'])
def printer_status():
    data = request.get_json(force=True)
    ip = data.get('ip', '')
    port = int(data.get('status_port', 4000))
    status = printer_comm.query_ethernet_status(ip, port)
    return jsonify(status)

def _process_incoming_items(items):
    for item in items:
        if item.get('type') == 'image' and 'image_data' in item:
            try:
                b64_str = item['image_data']
                if ',' in b64_str:
                    b64_str = b64_str.split(',')[1]
                img_bytes = base64.b64decode(b64_str)
                item['image'] = PILImage.open(io.BytesIO(img_bytes))
            except Exception as e:
                print(f"Error decoding image: {e}")
    return items


def _render_escpos_preview(items, target_width, chars_per_line, left_margin):
    # base64 conversion
    items = _process_incoming_items(items)
    raw = escpos_gen.compile_receipt(items, target_width, chars_per_line, left_margin)
    parsed = escpos_gen.parse_receipt(raw)

    char_h = 16
    line_w = target_width
    lines = []

    for item in parsed:
        itype = item.get('type', 'text')
        if itype == 'separator':
            lines.append(('sep',))
        elif itype == 'feed':
            for _ in range(item.get('lines', 1)):
                lines.append(('blank',))
        elif itype == 'image':
            lines.append(('image', item.get('image')))
        elif itype == 'text':
            dw = item.get('double_width', False)
            dh = item.get('double_height', False)
            bold = item.get('bold', False)
            align = item.get('align', 'left')
            text = item.get('text', '')
            right_text = item.get('right_text', '')
            if right_text:
                c_limit = (chars_per_line // 2) if dw else chars_per_line
                spaces = c_limit - len(text) - len(right_text)
                text = text + ' ' * max(1, spaces) + right_text
            lines.append(('text', text, bold, dw, dh, align))

    total_h = 0
    for line in lines:
        kind = line[0]
        if kind == 'image' and len(line) > 1 and line[1]:
            total_h += line[1].height + 4
        elif kind in ('sep', 'blank'):
            total_h += char_h
        else:
            dh = line[4] if len(line) > 4 else False
            total_h += (char_h * 2) if dh else char_h

    pad = 24
    paper_bg = (254, 251, 244) # GTK _PAPER
    text_color = (20, 20, 25)  # GTK _TEXT

    canvas = PILImage.new('RGB', (line_w + pad * 2, max(total_h, 60) + pad * 2), color=paper_bg)
    draw = ImageDraw.Draw(canvas)

    try:
        font_normal = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 13)
        font_bold   = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', 13)
        font_large  = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', 18)
    except Exception:
        font_normal = font_bold = font_large = ImageFont.load_default()

    y = pad
    for line in lines:
        kind = line[0]
        if kind == 'sep':
            draw.line([(left_margin + pad, y + char_h // 2), (line_w - left_margin + pad, y + char_h // 2)],
                      fill=text_color, width=1)
            y += char_h
        elif kind == 'blank':
            y += char_h
        elif kind == 'image':
            img_obj = line[1] if len(line) > 1 else None
            if img_obj:
                canvas.paste(img_obj.convert('RGB'), (left_margin + pad, y))
                y += img_obj.height + 4
        else:
            text  = line[1] if len(line) > 1 else ''
            bold  = line[2] if len(line) > 2 else False
            dw    = line[3] if len(line) > 3 else False
            dh    = line[4] if len(line) > 4 else False
            align = line[5] if len(line) > 5 else 'left'
            font  = font_large if (dw or dh) else (font_bold if bold else font_normal)
            
            try:
                bbox = draw.textbbox((0, 0), text, font=font)
                tw = bbox[2] - bbox[0]
            except Exception:
                tw = len(text) * 8
                
            if align == 'center':
                tx = max(left_margin, (line_w - tw) // 2)
            elif align == 'right':
                tx = max(left_margin, line_w - tw - left_margin)
            else:
                tx = left_margin
                
            draw.text((tx + pad, y), text, fill=text_color, font=font)
            y += (char_h * 2) if dh else char_h

    buf = io.BytesIO()
    canvas.save(buf, format='PNG')
    buf.seek(0)
    return base64.b64encode(buf.read()).decode('ascii')


@app.route('/api/preview/escpos', methods=['POST'])
def preview_escpos():
    data = request.get_json(force=True)
    items = data.get('items', [])
    target_width   = int(data.get('target_width', 576))
    chars_per_line = int(data.get('chars_per_line', 48))
    left_margin    = int(data.get('left_margin', 0))
    try:
        b64 = _render_escpos_preview(items, target_width, chars_per_line, left_margin)
        return jsonify({'success': True, 'preview': 'data:image/png;base64,' + b64})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/print/escpos', methods=['POST'])
def print_escpos():
    data = request.get_json(force=True)
    items          = data.get('items', [])
    target_width   = int(data.get('target_width', 576))
    chars_per_line = int(data.get('chars_per_line', 48))
    left_margin    = int(data.get('left_margin', 0))
    autocut        = bool(data.get('autocut', True))
    mode           = data.get('mode', 'ethernet')
    
    items = _process_incoming_items(items)
    
    try:
        raw = escpos_gen.compile_receipt(items, target_width, chars_per_line, left_margin)
        if autocut:
            raw += b'\x1D\x56\x42\x00'
    except Exception as e:
        return jsonify({'success': False, 'error': f'Compile error: {e}'})

    if mode == 'usb':
        ok, err = printer_comm.write_to_printer(data.get('path', ''), raw)
    else:
        ok, err = printer_comm.print_with_status_check(
            data.get('ip', ''), raw,
            int(data.get('status_port', 4000)),
            int(data.get('print_port', 9100))
        )
    return jsonify({'success': ok, 'error': str(err) if err else None})


@app.route('/api/export/escpos', methods=['POST'])
def export_escpos():
    data = request.get_json(force=True)
    autocut = bool(data.get('autocut', True))
    try:
        raw = escpos_gen.compile_receipt(
            data.get('items', []),
            int(data.get('target_width', 576)),
            int(data.get('chars_per_line', 48)),
            int(data.get('left_margin', 0))
        )
        if autocut:
            raw += b'\x1D\x56\x42\x00'
        return send_file(io.BytesIO(raw), mimetype='application/octet-stream',
                         as_attachment=True, download_name='receipt.bin')
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/import/escpos', methods=['POST'])
def import_escpos():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file uploaded'}), 400
    raw = request.files['file'].read()
    try:
        parsed = escpos_gen.parse_receipt(raw)
        if not parsed:
            return jsonify({'success': False, 'error': 'Empty or invalid ESC/POS binary'})
        clean = [{k: v for k, v in it.items() if not hasattr(v, 'save')} for it in parsed]
        return jsonify({'success': True, 'items': clean})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/receipt/export', methods=['POST'])
def export_receipt_bin():
    try:
        data = request.get_json(force=True)
        items = data.get('items', [])
        target_width = int(data.get('target_width', 576))
        chars_per_line = int(data.get('chars_per_line', 48))
        left_margin = int(data.get('left_margin', 0))
        
        items = _process_incoming_items(items)
        
        raw = escpos_gen.compile_receipt(items, target_width, chars_per_line, left_margin)
        if not raw.endswith(b'\x1D\x56\x42\x00'):
            raw += b'\x1D\x56\x42\x00' # Cut
            
        return send_file(
            io.BytesIO(raw),
            mimetype='application/octet-stream',
            as_attachment=True,
            download_name='receipt.bin'
        )
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/receipt/import', methods=['POST'])
def import_receipt_bin():
    """Base64."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file uploaded'}), 400
    try:
        file_bytes = request.files['file'].read()
        parsed_items = escpos_gen.parse_receipt(file_bytes)
        
        serializable_items = []
        for item in parsed_items:
            new_item = {k: v for k, v in item.items() if k != 'image'}
            
            if item.get('type') == 'image' and 'image' in item:
                img = item['image']
                buf = io.BytesIO()
                img.save(buf, format='PNG')
                b64_str = base64.b64encode(buf.getvalue()).decode('utf-8')
                new_item['image_data'] = f"data:image/png;base64,{b64_str}"
                
            serializable_items.append(new_item)
            
        return jsonify({'success': True, 'items': serializable_items})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/label/export', methods=['POST'])
def export_label_bin():
    """.bin"""
    try:
        data = request.get_json(force=True)
        width = float(data.get('width', 60.0))
        height = float(data.get('height', 40.0))
        gap = float(data.get('gap', 3.0))
        elements = data.get('elements', [])
        
        # Hydrate embedded labels back to PIL instances
        for el in elements:
            if el.get('type') == 'image' and 'image_data' in el:
                b64_str = el['image_data']
                if ',' in b64_str:
                    b64_str = b64_str.split(',')[1]
                img_bytes = base64.b64decode(b64_str)
                el['image'] = PILImage.open(io.BytesIO(img_bytes))
                
        raw = tspl_gen.compile_label(width, height, gap, elements)
        return send_file(
            io.BytesIO(raw),
            mimetype='application/octet-stream',
            as_attachment=True,
            download_name='label.bin'
        )
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/label/import', methods=['POST'])
def import_label_bin():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file uploaded'}), 400
    try:
        file_bytes = request.files['file'].read()
        width_mm, height_mm, gap_mm, elements = tspl_gen.parse_label(file_bytes)
        
        serializable_elements = []
        for el in elements:
            new_el = {k: v for k, v in el.items() if k != 'image'}
            
            if el.get('type') == 'image' and 'image' in el:
                img = el['image']
                buf = io.BytesIO()
                img.save(buf, format='PNG')
                b64_str = base64.b64encode(buf.getvalue()).decode('utf-8')
                new_el['image_data'] = f"data:image/png;base64,{b64_str}"
                
            serializable_elements.append(new_el)
            
        return jsonify({
            'success': True, 
            'width': width_mm, 
            'height': height_mm, 
            'gap': gap_mm, 
            'elements': serializable_elements
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


def _render_tspl_preview(width_mm, height_mm, gap_mm, elements):
    from PIL import Image, ImageDraw, ImageFont

    DPI = 203
    MM_TO_DOT = DPI / 25.4
    w_px = max(1, int(width_mm * MM_TO_DOT))
    h_px = max(1, int(height_mm * MM_TO_DOT))

    canvas = Image.new('RGB', (w_px, h_px), color=(255, 255, 255))
    draw   = ImageDraw.Draw(canvas)

    try:
        font_sm = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 11)
        font_md = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 14)
        font_lg = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 18)
    except Exception:
        font_sm = font_md = font_lg = ImageFont.load_default()

    font_map = {'1': font_sm, '2': font_sm, '3': font_md, '4': font_lg, '5': font_lg}

    for el in elements:
        etype = el.get('type', 'text')
        x = el.get('x', 0)
        y = el.get('y', 0)

        if etype == 'text':
            font = font_map.get(str(el.get('font', '3')), font_md)
            draw.text((x, y), el.get('text', ''), fill=(0, 0, 0), font=font)

        elif etype == 'barcode':
            content = el.get('content', '')
            bh = el.get('height', 50)
            bw = 2
            bx = x
            for i, ch in enumerate(content):
                fill = (0, 0, 0) if i % 2 == 0 else (255, 255, 255)
                draw.rectangle([bx, y, bx + bw - 1, y + bh], fill=fill)
                bx += bw
            if el.get('readable', 1):
                try:
                    fm = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 10)
                except Exception:
                    fm = ImageFont.load_default()
                draw.text((x, y + bh + 2), content, fill=(0, 0, 0), font=fm)

        elif etype == 'qrcode':
            cell_w = el.get('cell_width', 4)
            size = cell_w * 25
            draw.rectangle([x, y, x + size, y + size], outline=(0, 0, 0), width=2)
            draw.line([x, y, x + size, y + size], fill=(180, 180, 180), width=1)
            draw.line([x + size, y, x, y + size], fill=(180, 180, 180), width=1)
            try:
                fq = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 8)
            except Exception:
                fq = ImageFont.load_default()
            draw.text((x + 2, y + size + 2), 'QR', fill=(0, 0, 0), font=fq)

        elif etype == 'image':
            img_obj = el.get('image')
            if img_obj and hasattr(img_obj, 'convert'):
                canvas.paste(img_obj.convert('RGB'), (x, y))

    draw.rectangle([0, 0, w_px - 1, h_px - 1], outline=(180, 180, 180), width=1)
    buf = io.BytesIO()
    canvas.save(buf, format='PNG')
    buf.seek(0)
    return base64.b64encode(buf.read()).decode('ascii')


@app.route('/api/preview/tspl', methods=['POST'])
def preview_tspl():
    data = request.get_json(force=True)
    try:
        b64 = _render_tspl_preview(
            float(data.get('width_mm', 50)),
            float(data.get('height_mm', 40)),
            float(data.get('gap_mm', 2)),
            data.get('elements', [])
        )
        return jsonify({'success': True, 'preview': 'data:image/png;base64,' + b64})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/print/tspl', methods=['POST'])
def print_tspl():
    data    = request.get_json(force=True)
    autocut = bool(data.get('autocut', False))
    mode    = data.get('mode', 'ethernet')
    elements = data.get('elements', [])
    
    for el in elements:
        if el.get('type') == 'image' and 'image_data' in el:
            b64_str = el['image_data']
            if ',' in b64_str:
                b64_str = b64_str.split(',')[1]
            try:
                el['image'] = PILImage.open(io.BytesIO(base64.b64decode(b64_str)))
            except Exception:
                pass
                
    try:
        raw = tspl_gen.compile_label(
            float(data.get('width_mm', 50)),
            float(data.get('height_mm', 40)),
            float(data.get('gap_mm', 2)),
            elements
        )
        if autocut:
            raw += b'CUT\r\n'
    except Exception as e:
        return jsonify({'success': False, 'error': f'Compile error: {e}'})

    if mode == 'usb':
        ok, err = printer_comm.write_to_printer(data.get('path', ''), raw)
    else:
        ok, err = printer_comm.send_to_ethernet_printer(
            data.get('ip', ''), int(data.get('print_port', 9100)), raw
        )
    return jsonify({'success': ok, 'error': str(err) if err else None})


@app.route('/api/export/tspl', methods=['POST'])
def export_tspl():
    data    = request.get_json(force=True)
    autocut = bool(data.get('autocut', False))
    try:
        raw = tspl_gen.compile_label(
            float(data.get('width_mm', 50)),
            float(data.get('height_mm', 40)),
            float(data.get('gap_mm', 2)),
            data.get('elements', [])
        )
        if autocut:
            raw += b'CUT\r\n'
        return send_file(io.BytesIO(raw), mimetype='application/octet-stream',
                         as_attachment=True, download_name='label.bin')
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/import/tspl', methods=['POST'])
def import_tspl():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file uploaded'}), 400
    raw = request.files['file'].read()
    try:
        w_mm, h_mm, g_mm, elements = tspl_gen.parse_label(raw)
        clean = []
        for el in elements:
            el2 = {k: v for k, v in el.items() if not hasattr(v, 'save')}
            if el.get('type') == 'image':
                el2['has_image'] = True
            clean.append(el2)
        return jsonify({'success': True, 'width_mm': w_mm, 'height_mm': h_mm,
                        'gap_mm': g_mm, 'elements': clean})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/preview/pdf', methods=['POST'])
def preview_pdf():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No PDF uploaded'}), 400
    page_num = int(request.form.get('page', 0))
    try:
        import fitz
        from PIL import Image as PILImage
        pdf_bytes   = request.files['file'].read()
        doc         = fitz.open(stream=pdf_bytes, filetype='pdf')
        total_pages = len(doc)
        page_num    = min(page_num, total_pages - 1)
        pix         = doc[page_num].get_pixmap(matrix=fitz.Matrix(1.5, 1.5))
        img         = PILImage.frombytes('RGB', (pix.width, pix.height), pix.samples)
        buf         = io.BytesIO()
        img.save(buf, format='PNG')
        buf.seek(0)
        b64 = base64.b64encode(buf.read()).decode('ascii')
        return jsonify({'success': True, 'preview': 'data:image/png;base64,' + b64,
                        'total_pages': total_pages})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/print/pdf', methods=['POST'])
def print_pdf():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No PDF uploaded'}), 400
        
    page_req = request.form.get('page', '0')
    target_width = int(request.form.get('target_width', 576))
    mode = request.form.get('mode', 'ethernet')
    
    try:
        import fitz
        from PIL import Image as PILImage
        pdf_bytes = request.files['file'].read()
        doc = fitz.open(stream=pdf_bytes, filetype='pdf')
        
        pages_to_print = range(len(doc)) if page_req == 'all' else [min(int(page_req), len(doc) - 1)]
        raw_all = bytearray(b'\x1B\x40')
        
        for p in pages_to_print:
            page = doc[p]
            zoom = target_width / page.rect.width
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
            img = PILImage.frombytes('L', (pix.width, pix.height), pix.samples).convert('1')
            raw_all.extend(escpos_gen.get_image_bytes(img, target_width))
            
        raw_all.extend(b'\x1D\x56\x42\x00') # Cut
        raw = bytes(raw_all)
        
    except Exception as e:
        return jsonify({'success': False, 'error': f'PDF render error: {e}'})

    if mode == 'usb':
        ok, err = printer_comm.write_to_printer(request.form.get('path', ''), raw)
    else:
        ok, err = printer_comm.print_with_status_check(
            request.form.get('ip', ''), raw,
            int(request.form.get('status_port', 4000)),
            int(request.form.get('print_port', 9100))
        )
    return jsonify({'success': ok, 'error': str(err) if err else None})


if __name__ == '__main__':
    print(f'GPrinter Web — modules loaded from: {DESKTOP_DIR}')
    print('Open http://localhost:5001 in your browser')
    app.run(host='0.0.0.0', port=5001, debug=False)
