#!/usr/bin/env python3
# X11 checks for the Linux container smoke (ADR 0004 §12). Run with DISPLAY set.
#   x11check.py overlays            -> JSON: top-level windows titled like the overlay, with geometry,
#                                      override-redirect, map state and input-shape rectangles
#   x11check.py clickthrough X Y    -> JSON: maps a plain window at (X-50, Y-50, 100x100) beneath
#                                      everything, clicks at (X, Y) through XTest, and reports
#                                      whether that window received the button press
import json
import sys
import time

from Xlib import X, display
from Xlib.ext import shape, xtest

TITLES = ('Desktop Cat', 'GizeCat')


def wm_name(d, w):
    try:
        n = w.get_wm_name()
        if n:
            return n if isinstance(n, str) else n.decode('utf-8', 'replace')
        prop = w.get_full_property(d.intern_atom('_NET_WM_NAME'), d.intern_atom('UTF8_STRING'))
        return prop.value.decode('utf-8', 'replace') if prop else None
    except Exception:
        return None


def walk(d, w, depth=0, out=None):
    out = [] if out is None else out
    try:
        children = w.query_tree().children
    except Exception:
        return out
    for c in children:
        out.append((c, depth))
        if depth < 3:
            walk(d, c, depth + 1, out)
    return out


def overlays():
    d = display.Display()
    root = d.screen().root
    found = []
    for w, depth in walk(d, root):
        name = wm_name(d, w)
        if not name or not name.startswith(TITLES):
            continue
        try:
            attrs = w.get_attributes()
            geo = w.get_geometry()
            trans = root.translate_coords(w, 0, 0)
        except Exception:
            continue
        entry = {
            'id': w.id,
            'name': name,
            'depth': depth,
            'mapped': attrs.map_state == X.IsViewable,
            'overrideRedirect': bool(attrs.override_redirect),
            'x': trans.x,
            'y': trans.y,
            'width': geo.width,
            'height': geo.height,
        }
        try:
            rects = w.shape_get_rectangles(shape.SK.Input)
            entry['inputRects'] = [[r.x, r.y, r.width, r.height] for r in rects.rectangles]
        except Exception as e:  # no SHAPE extension or no input shape set
            entry['inputRects'] = None
            entry['inputShapeError'] = str(e)
        found.append(entry)
    print(json.dumps({'overlays': found}))


def clickthrough(x, y, blocker=False):
    d = display.Display()
    screen = d.screen()
    root = screen.root
    win = root.create_window(
        x - 50, y - 50, 100, 100, 0, screen.root_depth, X.InputOutput, X.CopyFromParent,
        background_pixel=screen.white_pixel, event_mask=X.ButtonPressMask | X.ExposureMask | X.StructureNotifyMask,
        override_redirect=True,
    )
    win.set_wm_name('gizecat-probe-target')
    win.map()
    # Keep the probe beneath the overlay: lower it to the bottom of the stack.
    win.configure(stack_mode=X.Below)
    blk = None
    if blocker:
        # Negative control: an ordinary input window on top of the probe must swallow the click.
        blk = root.create_window(x - 80, y - 80, 160, 160, 0, screen.root_depth, X.InputOutput, X.CopyFromParent, background_pixel=screen.black_pixel, event_mask=X.ButtonPressMask, override_redirect=True)
        blk.map()
        blk.configure(stack_mode=X.Above)
    d.sync()
    time.sleep(0.5)
    xtest.fake_input(d, X.MotionNotify, x=x, y=y)
    d.sync()
    time.sleep(0.3)
    xtest.fake_input(d, X.ButtonPress, 1)
    xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()
    got = False
    deadline = time.time() + 2
    while time.time() < deadline:
        while d.pending_events():
            ev = d.next_event()
            if ev.type == X.ButtonPress and ev.window.id == win.id:
                got = True
        if got:
            break
        time.sleep(0.05)
    pointer = root.query_pointer()
    under = pointer.child.id if pointer.child else None
    win.destroy()
    if blk is not None:
        blk.destroy()
    d.sync()
    print(json.dumps({'blocker': blocker, 'clickReachedWindowBelow': got, 'pointerChildId': under, 'probeId': win.id, 'at': [x, y]}))


if __name__ == '__main__':
    if sys.argv[1] == 'overlays':
        overlays()
    elif sys.argv[1] == 'clickthrough':
        clickthrough(int(sys.argv[2]), int(sys.argv[3]))
    elif sys.argv[1] == 'clickthrough-blocked':
        clickthrough(int(sys.argv[2]), int(sys.argv[3]), blocker=True)
    else:
        raise SystemExit('usage: x11check.py overlays | clickthrough X Y')
