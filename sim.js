/* ------------------------------------------------------------------
 * sim.js -- a tiny model of a C process image, plus a hand-written
 * execution trace for each example in code/.
 *
 * The point of the model: a pointer's VALUE is a number (an address),
 * and the arrows drawn on screen are the result of looking that number
 * up in the memory map. Nothing holds a reference to anything else. So
 * p++ really does land on the next element, and free() really does
 * leave the arrow pointing at a block that is no longer yours.
 * ------------------------------------------------------------------ */

const STACK_TOP = 0x7ffee3c0;   /* locals grow DOWNWARD from here  */
const HEAP_BASE = 0x600003a0;   /* malloc grows UPWARD from here   */
const RO_BASE   = 0x100003f0;   /* string literals live down here  */

const hexa = a => (a === 0 ? '0x0' : '0x' + a.toString(16));
const NUL  = '\0';

/* How one cell's contents should read on screen. */
function fmt(c) {
  if (c.value === undefined) return '?';
  if (c.vk === 'ptr')  return c.value === 0 ? 'NULL' : hexa(c.value);
  if (c.vk === 'char') return c.value === NUL ? "'\\0'" : "'" + c.value + "'";
  return String(c.value);
}

class Mem {
  constructor() {
    this.frames = [];      /* [{fn, base, slots:[]}] -- innermost last */
    this.blocks = [];      /* heap blocks from malloc                  */
    this.ro     = [];      /* read-only string literals                */
    this.text   = '';      /* everything printf has emitted so far     */
    this.changed = new Set();   /* cells written during this step       */
    this.focus   = new Set();   /* cells read during this step          */
    this.sp = STACK_TOP;
    this.hp = HEAP_BASE;
    this.rp = RO_BASE;
    this.uid = 0;
  }
  nid() { return ++this.uid; }

  /* ---------------- stack frames ---------------- */
  frame(fn) { this.frames.push({ fn, base: this.sp, slots: [] }); }
  ret() { const f = this.frames.pop(); if (f) this.sp = f.base; }
  top() { return this.frames[this.frames.length - 1]; }
  pad(n) { this.sp -= n; }           /* alignment padding the compiler inserts */

  alloc(size, al) {
    let a = this.sp - size;
    a -= a % al;                     /* align downward */
    this.sp = a;
    return a;
  }
  addSlot(kind, name, type, cells, extra) {
    const s = Object.assign({ id: this.nid(), kind, name, type, cells }, extra || {});
    this.top().slots.push(s);
    cells.forEach(c => this.changed.add(c.id));
    return s;
  }

  /* ---------------- declarations ---------------- */
  scalar(name, type, value, opt) {
    opt = opt || {};
    const size = opt.size || 4;
    const addr = this.alloc(size, size);
    const c = { id: this.nid(), addr, size, value, vk: opt.vk || 'int', flags: {} };
    return this.addSlot('scalar', name, type, [c]);
  }
  ptr(name, type, value) {
    const addr = this.alloc(8, 8);
    const c = { id: this.nid(), addr, size: 8, value, vk: 'ptr', flags: {} };
    return this.addSlot('ptr', name, type, [c]);
  }
  array(name, type, values, es) {
    es = es || 4;
    const base = this.alloc(es * values.length, es);
    const cells = values.map((v, i) => ({
      id: this.nid(), addr: base + i * es, size: es, value: v, vk: 'int', idx: i, flags: {}
    }));
    this.addSlot('array', name, type, cells, { base, es });
    return base;
  }
  charArray(name, str, cap) {
    const base = this.alloc(cap, 1);
    const cells = [];
    for (let i = 0; i < cap; i++) {
      cells.push({
        id: this.nid(), addr: base + i, size: 1, idx: i, vk: 'char',
        value: i < str.length ? str[i] : NUL, flags: {}
      });
    }
    this.addSlot('bytes', name, 'char[' + cap + ']', cells, { base, es: 1 });
    return base;
  }
  literal(text) {                    /* a "..." in the read-only section */
    const base = this.rp, full = text + NUL, cells = [];
    for (let i = 0; i < full.length; i++) {
      cells.push({
        id: this.nid(), addr: base + i, size: 1, idx: i, vk: 'char',
        value: full[i], flags: { ro: true }
      });
    }
    this.rp += full.length;
    this.rp += (4 - this.rp % 4) % 4;
    this.ro.push({ id: this.nid(), label: '"' + text + '"', base, cells });
    cells.forEach(c => this.changed.add(c.id));
    return base;
  }

  /* ---------------- the heap ---------------- */
  malloc(label, count, es) {
    const base = this.hp, cells = [];
    for (let i = 0; i < count; i++) {
      cells.push({
        id: this.nid(), addr: base + i * es, size: es, idx: i,
        vk: 'int', value: undefined, flags: {}     /* malloc does not zero */
      });
    }
    this.hp += count * es;
    this.hp += (16 - this.hp % 16) % 16;           /* allocator granularity */
    this.blocks.push({ id: this.nid(), label, base, es, cells, freed: false });
    cells.forEach(c => this.changed.add(c.id));
    return base;
  }
  blockAt(a) {
    return this.blocks.find(b => a >= b.base && a < b.base + b.cells.length * b.es);
  }
  free(a) {
    const b = this.blockAt(a);
    if (b) { b.freed = true; b.cells.forEach(c => { c.flags.freed = true; }); }
  }

  /* ---------------- lookups ---------------- */
  slot(name) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const s = this.frames[i].slots.find(s => s.name === name);
      if (s) return s;
    }
    return null;
  }
  drop(name) {                        /* a block-scoped local going away */
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i], k = f.slots.findIndex(s => s.name === name);
      if (k >= 0) { f.slots.splice(k, 1); return; }
    }
  }
  cellAt(a) {
    for (const f of this.frames)
      for (const s of f.slots) {
        const c = s.cells.find(c => c.addr === a);
        if (c) return c;
      }
    for (const b of this.blocks) {
      const c = b.cells.find(c => c.addr === a);
      if (c) return c;
    }
    for (const r of this.ro) {
      const c = r.cells.find(c => c.addr === a);
      if (c) return c;
    }
    return null;
  }

  /* ---------------- reads and writes ---------------- */
  set(name, v) {
    const s = this.slot(name);
    if (s) { s.cells[0].value = v; this.changed.add(s.cells[0].id); }
  }
  setIdx(name, i, v) {
    const s = this.slot(name);
    if (s && s.cells[i]) { s.cells[i].value = v; this.changed.add(s.cells[i].id); }
  }
  writeAt(a, v) {
    const c = this.cellAt(a);
    if (c) { c.value = v; this.changed.add(c.id); }
    return c;
  }
  readAt(a) {
    const c = this.cellAt(a);
    if (c) this.focus.add(c.id);
    return c ? c.value : undefined;
  }
  look(name) {
    const s = this.slot(name);
    if (s) s.cells.forEach(c => this.focus.add(c.id));
    return s;
  }
  lookIdx(name, i) {
    const s = this.slot(name);
    if (s && s.cells[i]) this.focus.add(s.cells[i].id);
  }
  mark(name, flag) {
    const s = this.slot(name);
    if (s) s.cells.forEach(c => { c.flags[flag] = true; });
  }

  /* ---------------- stdout ---------------- */
  print(s) { this.text += s + '\n'; }
  emit(s)  { this.text += s; }

  /* ---------------- helpers used by the watch table ---------------- */
  A(name) { const s = this.slot(name); return s ? hexa(s.cells[0].addr) : '--'; }
  V(name) { const s = this.slot(name); return s ? fmt(s.cells[0]) : '--'; }
  raw(name) { const s = this.slot(name); return s ? s.cells[0].value : undefined; }
  /* one dereference, with the usual ways it can go wrong */
  D(name) {
    const s = this.slot(name);
    if (!s || s.cells[0].vk !== 'ptr') return '--';
    const a = s.cells[0].value;
    if (a === 0) return 'crash (NULL)';
    const b = this.blockAt(a);
    if (b && b.freed) return 'dangling';
    const c = this.cellAt(a);
    return c ? fmt(c) : 'no object there';
  }
  DD(name) {                          /* two dereferences: **pp */
    const a = this.raw(name);
    if (a === undefined || a === 0) return '--';
    const mid = this.cellAt(a);
    if (!mid || mid.vk !== 'ptr') return '--';
    const c = this.cellAt(mid.value);
    return c ? fmt(c) : '--';
  }
  str(name) {                         /* read a char array as a string */
    const s = this.slot(name);
    if (!s) return '--';
    let out = '';
    for (const c of s.cells) { if (c.value === NUL) break; out += c.value; }
    return '"' + out + '"';
  }
  strAt(a) {
    let out = '';
    for (let i = 0; i < 64; i++) {
      const c = this.cellAt(a + i);
      if (!c || c.value === NUL) break;
      out += c.value;
    }
    return '"' + out + '"';
  }
}

/* ------------------------------------------------------------------
 * A very small C syntax highlighter: enough for these eight files.
 * ------------------------------------------------------------------ */
const C_KEY = new Set(['return', 'if', 'else', 'for', 'while', 'do', 'sizeof',
  'const', 'void', 'struct', 'break', 'continue', 'switch', 'case', 'default',
  'static', 'NULL', 'malloc', 'free', 'printf']);
const C_TYPE = new Set(['int', 'char', 'long', 'short', 'unsigned', 'signed',
  'float', 'double', 'size_t']);

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, s) => '<span class="' + cls + '">' + esc(s) + '</span>';

function highlight(line) {
  let out = '', i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '#') { out += span('tok-pp', line.slice(i)); break; }
    if (c === '/' && line[i + 1] === '*') {
      let j = line.indexOf('*/', i + 2);
      j = j < 0 ? line.length : j + 2;
      out += span('tok-com', line.slice(i, j)); i = j; continue;
    }
    if (c === '*' && line[i + 1] === '/') {       /* tail of a block comment */
      out += span('tok-com', line.slice(i, i + 2)); i += 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === c) { j++; break; }
        j++;
      }
      out += span('tok-str', line.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
      const w = line.slice(i, j);
      out += C_TYPE.has(w) ? span('tok-type', w)
           : C_KEY.has(w)  ? span('tok-key', w)
           : esc(w);
      i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX.]/.test(line[j])) j++;
      out += span('tok-num', line.slice(i, j)); i = j; continue;
    }
    out += esc(c); i++;
  }
  return out;
}

/* two conveniences used constantly by the traces below */
Mem.prototype.ad = function (n) { const s = this.slot(n); return s ? s.cells[0].addr : 0; };
Mem.prototype.elem = function (n, i) { const s = this.slot(n); return s ? fmt(s.cells[i]) : '--'; };

/* ------------------------------------------------------------------
 * The traces. One entry per file in code/. Each step highlights a
 * line, mutates memory, and explains itself.
 * ------------------------------------------------------------------ */
/* Narration for one turn of the string-walk loop in 07_strings.c */
function walkSay(m) {
  const here = m.raw('s'), done = m.cellAt(here - 1), next = m.cellAt(here);
  const nx = next.value === NUL ? "the terminator <code>'\\0'</code>"
                                : "<code>'" + next.value + "'</code>";
  return 'Printed <code>[' + done.value + ']</code>, then <code>s++</code> moved exactly one byte to <code>' +
         hexa(here) + '</code>, where <code>*s</code> is now ' + nx + '.';
}

const EXAMPLES = [

/* ===================== 1 ===================== */
{
  file: '01_addresses.c',
  tab: 'Address of',
  title: 'A variable, its address, and a pointer to it',
  blurb: 'Three ideas, and everything else is built on them: <code>&amp;x</code> is the address of x, ' +
         'a pointer is an ordinary variable whose value happens to be an address, and <code>*p</code> ' +
         'means "the object living at the address in p". Watch the two boxes appear at two different addresses.',
  init(m) { m.frame('main'); },
  watch: [
    ['x',        m => m.V('x')],
    ['&amp;x',   m => m.A('x')],
    ['p',        m => m.V('p')],
    ['&amp;p',   m => m.A('p')],
    ['*p',       m => m.D('p')],
    ['sizeof x', m => m.slot('x') ? '4' : '--'],
    ['sizeof p', m => m.slot('p') ? '8' : '--']
  ],
  steps: [
    { line: 7, do: m => { m.scalar('x', 'int', 42); },
      say: m => 'Four bytes are set aside in main&rsquo;s frame and 42 is written into them. ' +
                'The name <code>x</code> is just a label the compiler keeps for the address <code>' + m.A('x') + '</code>.' },
    { line: 8, do: m => { m.look('x'); m.ptr('p', 'int *', m.ad('x')); },
      say: m => '<code>&amp;x</code> evaluates to <code>' + m.A('x') + '</code>, and that number is copied into ' +
                '<code>p</code>. <code>p</code> is a variable in its own right, eight bytes at <code>' + m.A('p') +
                '</code>. The arrow on the right is nothing but that number, looked up.' },
    { line: 10, do: m => { m.look('x'); m.print('x        = ' + m.V('x')); },
      say: 'Plain <code>x</code> reads the four bytes directly &mdash; no pointer involved.' },
    { line: 11, do: m => { m.look('x'); m.print('&x       = ' + m.A('x')); },
      say: 'Printing the address itself. Yours will differ on every run, and that is fine &mdash; nothing in a correct program depends on the actual number.' },
    { line: 12, do: m => { m.look('p'); m.print('p        = ' + m.V('p')); },
      say: 'Reading <code>p</code> gives the same number back. A pointer holds an address and nothing else.' },
    { line: 13, do: m => { m.look('p'); m.readAt(m.raw('p')); m.print('*p       = ' + m.D('p')); },
      say: 'Two memory accesses this time: fetch the address out of <code>p</code>, then go to that address and fetch the int. That second hop is the dereference.' },
    { line: 14, do: m => { m.look('x'); m.print('sizeof x = 4 bytes'); },
      say: '<code>sizeof x</code> is the size of the <em>int</em>: 4 bytes on this machine.' },
    { line: 15, do: m => { m.look('p'); m.print('sizeof p = 8 bytes'); },
      say: '<code>sizeof p</code> is the size of an <em>address</em>: 8 bytes on a 64-bit machine. ' +
           'It is 8 for <code>int *</code>, <code>char *</code>, <code>double *</code> &mdash; what it points at makes no difference to how big the pointer is.' },
    { line: 16, do: m => { m.ret(); },
      say: 'main returns, its frame is popped, and both <code>x</code> and <code>p</code> stop existing. Any pointer to them that outlived this moment would be dangling.' }
  ]
},

/* ===================== 2 ===================== */
{
  file: '02_deref.c',
  tab: 'Dereference',
  title: 'Reading and writing through a pointer',
  blurb: 'A dereference on the left of <code>=</code> is a store, not a load. <code>*p = 99</code> never ' +
         'mentions <code>x</code>, yet <code>x</code> is what changes &mdash; the single most useful and ' +
         'most dangerous property of pointers. Then watch the difference between changing <em>what p points at</em> ' +
         'and changing <em>p itself</em>.',
  init(m) { m.frame('main'); },
  watch: [
    ['x',      m => m.V('x')],
    ['y',      m => m.V('y')],
    ['&amp;x', m => m.A('x')],
    ['&amp;y', m => m.A('y')],
    ['p',      m => m.V('p')],
    ['*p',     m => m.D('p')]
  ],
  steps: [
    { line: 7, do: m => { m.scalar('x', 'int', 10); },
      say: 'Two ordinary ints first.' },
    { line: 8, do: m => { m.scalar('y', 'int', 7); },
      say: m => '<code>y</code> lands four bytes below <code>x</code> &mdash; locals are carved out of the frame going downward, so the second declaration gets the lower address.' },
    { line: 9, do: m => { m.look('x'); m.ptr('p', 'int *', m.ad('x')); },
      say: '<code>p</code> is aimed at <code>x</code>.' },
    { line: 11, do: m => { m.look('p'); m.writeAt(m.raw('p'), 99); },
      say: 'Read it as an instruction: <em>take the address in p, go there, store 99</em>. The statement does not contain the letter x, but x is now 99. This is how a function can modify a caller&rsquo;s variable.' },
    { line: 12, do: m => { m.look('x'); m.print('x = ' + m.V('x')); },
      say: 'Confirmed by reading <code>x</code> the ordinary way.' },
    { line: 14, do: m => { m.look('p'); m.writeAt(m.raw('p'), m.readAt(m.raw('p')) + 1); },
      say: 'The parentheses matter. <code>(*p)++</code> increments the <em>pointee</em>, 99 to 100. ' +
           'Written <code>*p++</code> it would instead increment <code>p</code> and leave x alone &mdash; a classic one-character bug.' },
    { line: 15, do: m => { m.look('x'); m.print('x = ' + m.V('x')); }, say: 'x is 100.' },
    { line: 17, do: m => { m.look('y'); m.set('p', m.ad('y')); },
      say: 'No star on the left this time, so we are assigning to <code>p</code> itself: the arrow swings over to <code>y</code>. <code>x</code> keeps the value it had.' },
    { line: 18, do: m => { m.look('p'); m.writeAt(m.raw('p'), 123); },
      say: 'The same statement as before, but it now lands in a different variable. Identical code, different target &mdash; that is the whole point of indirection.' },
    { line: 19, do: m => { m.look('x'); m.look('y'); m.print('x = ' + m.V('x') + ', y = ' + m.V('y')); },
      say: 'x kept 100; y took the 123.' },
    { line: 20, do: m => { m.ret(); }, say: 'Frame popped.' }
  ]
},

/* ===================== 3 ===================== */
{
  file: '03_arithmetic.c',
  tab: 'Arithmetic',
  title: 'Pointer arithmetic counts elements, not bytes',
  blurb: '<code>p + 1</code> does not mean "one byte later". It means "the next object of this type", so for ' +
         '<code>int *</code> it moves four bytes. Keep an eye on the address in the watch table as the arrow ' +
         'walks down the array &mdash; and notice that <code>a[i]</code> is defined to mean <code>*(a + i)</code>.',
  init(m) { m.frame('main'); },
  watch: [
    ['p',         m => m.V('p')],
    ['*p',        m => m.D('p')],
    ['p - a',     m => { const s = m.slot('a'); return s && m.raw('p') !== undefined ? String((m.raw('p') - s.base) / 4) : '--'; }],
    ['a[3]',      m => m.elem('a', 3)],
    ['sizeof a',  m => m.slot('a') ? '20' : '--'],
    ['sizeof p',  m => m.slot('p') ? '8' : '--']
  ],
  steps: [
    { line: 7, do: m => { m.array('a', 'int[5]', [10, 20, 30, 40, 50]); },
      say: m => 'Twenty contiguous bytes, five ints. Contiguity is guaranteed by the language, which is exactly what makes the arithmetic below well defined. The array starts at <code>' + m.A('a') + '</code>.' },
    { line: 8, do: m => { m.look('a'); m.ptr('p', 'int *', m.slot('a').base); },
      say: 'Used in an expression, the array name <em>decays</em> to a pointer to its first element, so <code>p = a</code> and <code>p = &amp;a[0]</code> are the same assignment. ' +
           'But <code>a</code> is not a pointer variable: <code>sizeof a</code> is 20 while <code>sizeof p</code> is 8.' },
    { line: 10, do: m => { m.look('p'); m.readAt(m.raw('p')); m.print('p = ' + m.V('p') + '  *p = ' + m.D('p')); },
      say: 'Pointing at element 0.' },
    { line: 11, do: m => { m.look('p'); m.set('p', m.raw('p') + 4); },
      say: m => '<code>p++</code> added <em>one element</em>, which is four bytes: the address went up by 4 to <code>' + m.V('p') + '</code>. The compiler scales by <code>sizeof(int)</code> for you. For a <code>char *</code> the same <code>p++</code> would move a single byte.' },
    { line: 12, do: m => { m.look('p'); m.readAt(m.raw('p')); m.print('p = ' + m.V('p') + '  *p = ' + m.D('p')); },
      say: 'Element 1.' },
    { line: 13, do: m => { m.look('p'); m.set('p', m.raw('p') + 8); },
      say: '<code>p += 2</code> skips two elements, eight bytes, landing on <code>a[3]</code>.' },
    { line: 14, do: m => { m.look('p'); m.readAt(m.raw('p')); m.print('p = ' + m.V('p') + '  *p = ' + m.D('p')); },
      say: 'Element 3.' },
    { line: 16, do: m => {
        m.look('p'); m.readAt(m.raw('p') - 4); m.lookIdx('a', 3);
        m.print('p[-1] = ' + fmt(m.cellAt(m.raw('p') - 4)) + '   a[3] = ' + m.elem('a', 3) + '   *(a+3) = ' + m.elem('a', 3));
      },
      say: 'Indexing is just arithmetic plus a dereference: <code>p[-1]</code> is <code>*(p - 1)</code>, one element back. ' +
           'And since <code>a[3]</code> <em>is</em> <code>*(a + 3)</code> by definition, the odd-looking <code>3[a]</code> would compile too.' },
    { line: 17, do: m => { m.look('p'); m.look('a'); m.print('p - a = ' + (m.raw('p') - m.slot('a').base) / 4 + ' elements'); },
      say: m => 'Subtracting two pointers gives a count of <em>elements</em>, not bytes: <code>(' + m.V('p') + ' - ' + m.A('a') + ') / 4 = 3</code>. ' +
                'This is only defined when both point into the same array.' },
    { line: 18, do: m => { m.ret(); }, say: 'Frame popped.' }
  ]
},

/* ===================== 4 ===================== */
{
  file: '04_swap.c',
  tab: 'Call by ref',
  title: 'Call by value vs. call by reference',
  blurb: 'C always passes arguments by value &mdash; it copies them. So a function cannot change a caller&rsquo;s ' +
         'variable unless you hand it the <em>address</em> and let it write through that. The two frames appearing ' +
         'and disappearing below are the whole explanation of why <code>swap_val</code> fails.',
  init(m) { m.frame('main'); },
  watch: [
    ['x (main)', m => { const f = m.frames[0]; const s = f && f.slots.find(s => s.name === 'x'); return s ? fmt(s.cells[0]) : '--'; }],
    ['y (main)', m => { const f = m.frames[0]; const s = f && f.slots.find(s => s.name === 'y'); return s ? fmt(s.cells[0]) : '--'; }],
    ['a (callee)', m => m.frames.length > 1 ? m.V('a') : '--'],
    ['b (callee)', m => m.frames.length > 1 ? m.V('b') : '--'],
    ['t (callee)', m => m.frames.length > 1 ? m.V('t') : '--'],
    ['*a',       m => m.frames.length > 1 ? m.D('a') : '--'],
    ['*b',       m => m.frames.length > 1 ? m.D('b') : '--']
  ],
  steps: [
    { line: 17, do: m => { m.scalar('x', 'int', 1); m.scalar('y', 'int', 2); },
      say: 'x = 1, y = 2 in main&rsquo;s frame.' },
    { line: 19, do: m => { m.look('x'); m.look('y'); m.frame('swap_val'); m.scalar('a', 'int', 1); m.scalar('b', 'int', 2); },
      say: 'Calling <code>swap_val(x, y)</code> pushes a new frame and <em>copies</em> the two values into it. ' +
           'The parameters <code>a</code> and <code>b</code> are fresh variables at fresh addresses. (A real frame also holds the return address and saved frame pointer; we are not drawing those.)' },
    { line: 7, do: m => { m.look('a'); m.scalar('t', 'int', 1); },
      say: '<code>int t = a;</code> &mdash; stash the first copy.' },
    { line: 7, do: m => { m.look('b'); m.set('a', m.raw('b')); },
      say: '<code>a = b;</code>' },
    { line: 7, do: m => { m.look('t'); m.set('b', m.raw('t')); },
      say: '<code>b = t;</code> The two copies are now genuinely swapped. Nothing in main&rsquo;s frame has been touched &mdash; look at the addresses: they are different variables.' },
    { line: 8, do: m => { m.ret(); },
      say: 'The function returns and the whole frame is discarded, swap included. The work was real, but it was done on the wrong objects.' },
    { line: 20, do: m => { m.look('x'); m.look('y'); m.print('after swap_val : x=' + m.V('x') + ' y=' + m.V('y')); },
      say: 'Still 1 and 2. This is the bug every C course opens with.' },
    { line: 22, do: m => {
        m.look('x'); m.look('y');
        const ax = m.ad('x'), ay = m.ad('y');
        m.frame('swap_ptr'); m.ptr('a', 'int *', ax); m.ptr('b', 'int *', ay);
      },
      say: 'This time we pass <code>&amp;x</code> and <code>&amp;y</code>. The addresses are still copied &mdash; C has no other mode &mdash; but a copy of an address still leads to the original object. The arrows now reach up into the caller&rsquo;s frame.' },
    { line: 12, do: m => { m.look('a'); m.scalar('t', 'int', m.readAt(m.raw('a'))); },
      say: '<code>int t = *a;</code> &mdash; follow the arrow and read: t = 1.' },
    { line: 12, do: m => { m.look('a'); m.look('b'); m.writeAt(m.raw('a'), m.readAt(m.raw('b'))); },
      say: '<code>*a = *b;</code> &mdash; read through b, write through a. That write lands in main&rsquo;s <code>x</code>.' },
    { line: 12, do: m => { m.look('b'); m.look('t'); m.writeAt(m.raw('b'), m.raw('t')); },
      say: '<code>*b = t;</code> &mdash; and main&rsquo;s <code>y</code> gets the stashed 1.' },
    { line: 13, do: m => { m.ret(); },
      say: 'The frame is discarded again &mdash; but this time the edits were made outside it, so they survive.' },
    { line: 23, do: m => { m.look('x'); m.look('y'); m.print('after swap_ptr : x=' + m.V('x') + ' y=' + m.V('y')); },
      say: 'Swapped. The difference between the two functions is not the algorithm; it is which memory they were allowed to reach.' },
    { line: 24, do: m => { m.ret(); }, say: 'main returns.' }
  ]
},

/* ===================== 5 ===================== */
{
  file: '05_heap.c',
  tab: 'Heap / malloc',
  title: 'The heap: malloc, free, and the dangling pointer',
  blurb: 'Locals die when their function returns, which is useless if you need memory to outlive the call or ' +
         'to be sized at run time. <code>malloc</code> hands you a block from the heap and returns its address. ' +
         'Notice how far the heap addresses are from the stack addresses &mdash; and that the pointer itself still lives on the stack.',
  init(m) { m.frame('main'); },
  watch: [
    ['n',        m => m.V('n')],
    ['arr',      m => m.V('arr')],
    ['&amp;arr', m => m.A('arr')],
    ['*arr',     m => m.D('arr')],
    ['arr[3]',   m => { const a = m.raw('arr'); if (!a) return '--'; const b = m.blockAt(a); if (b && b.freed) return 'dangling'; const c = m.cellAt(a + 12); return c ? fmt(c) : '--'; }],
    ['i',        m => m.V('i')]
  ],
  steps: [
    { line: 8, do: m => { m.scalar('n', 'int', 4); },
      say: 'The count is a run-time value here. A plain <code>int a[n]</code> would be a variable-length array, which is a different (and more limited) tool.' },
    { line: 9, do: m => { m.look('n'); const b = m.malloc('malloc(16)', 4, 4); m.ptr('arr', 'int *', b); },
      say: m => '<code>malloc</code> carves out 4 &times; 4 = 16 bytes and returns their address, <code>' + m.V('arr') + '</code>. ' +
                'Two things to notice: the block holds <em>garbage</em> (malloc does not zero it &mdash; <code>calloc</code> does), and the heap sits in an entirely different part of the address space from the stack.' },
    { line: 10, do: m => { m.look('arr'); },
      say: 'Always check the result. <code>malloc</code> returns <code>NULL</code> when it cannot satisfy the request, and the next dereference would be a crash.' },
    { line: 12, do: m => { m.look('arr'); m.scalar('i', 'int', 0); },
      say: '<code>i</code> is scoped to the loop, so it gets a slot in the frame for the duration.' },
    { line: 13, do: m => { m.look('i'); m.look('arr'); m.writeAt(m.raw('arr') + 0, 11); m.set('i', 1); },
      say: m => '<code>arr[0] = 11</code> is <code>*(arr + 0) = 11</code>: a write at <code>' + m.V('arr') + '</code>. Indexing a pointer is identical to indexing an array.' },
    { line: 13, do: m => { m.look('i'); m.look('arr'); m.writeAt(m.raw('arr') + 4, 22); m.set('i', 2); },
      say: '<code>arr[1] = 22</code> &mdash; four bytes further on.' },
    { line: 13, do: m => { m.look('i'); m.look('arr'); m.writeAt(m.raw('arr') + 8, 33); m.set('i', 3); },
      say: '<code>arr[2] = 33</code>' },
    { line: 13, do: m => { m.look('i'); m.look('arr'); m.writeAt(m.raw('arr') + 12, 44); m.set('i', 4); },
      say: '<code>arr[3] = 44</code> &mdash; the last element we own. <code>arr[4]</code> would be a heap buffer overflow: no diagnostic, just corruption.' },
    { line: 12, do: m => { m.look('i'); m.drop('i'); },
      say: '<code>i</code> reaches 4, the loop ends, and <code>i</code> leaves scope.' },
    { line: 15, do: m => { m.readAt(m.raw('arr')); m.readAt(m.raw('arr') + 12); m.print('arr[0]=' + fmt(m.cellAt(m.raw('arr'))) + '  arr[3]=' + fmt(m.cellAt(m.raw('arr') + 12))); },
      say: 'Reading the block back.' },
    { line: 16, do: m => { m.look('arr'); m.print('arr  = ' + m.V('arr') + '   (points into the heap)'); },
      say: 'The <em>value</em> of arr is a heap address.' },
    { line: 17, do: m => { m.look('arr'); m.print('&arr = ' + m.A('arr') + '   (the pointer itself is on the stack)'); },
      say: 'The <em>location</em> of arr is a stack address. Keeping these two apart is most of what it takes to reason about heap code: ' +
           'the 8-byte pointer is automatic and dies with the frame, the 16-byte block is not and does not.' },
    { line: 19, do: m => { m.look('arr'); m.free(m.raw('arr')); m.mark('arr', 'danger'); },
      say: 'The 16 bytes go back to the allocator. Three things did <em>not</em> happen: the bytes were not erased, ' +
           '<code>arr</code> was not changed, and nothing was marked invalid. <code>arr</code> still holds that address, but following it is now undefined behaviour &mdash; it is a dangling pointer, and it may appear to work for a while, which is what makes the bug so expensive.' },
    { line: 20, do: m => { m.set('arr', 0); const s = m.slot('arr'); s.cells[0].flags.danger = false; },
      say: 'Setting it to <code>NULL</code> costs one instruction and converts a silent, intermittent bug into an immediate and obvious crash. ' +
           'Forgetting the <code>free</code> entirely is the other failure mode: a leak.' },
    { line: 21, do: m => { m.ret(); },
      say: 'main returns. The frame goes away &mdash; and because we freed the block, so has the heap memory.' }
  ]
},

/* ===================== 6 ===================== */
{
  file: '06_pointer_to_pointer.c',
  tab: 'Pointer to pointer',
  title: 'Two levels of indirection',
  blurb: 'If a pointer is just a variable, it has an address too &mdash; so you can point at it. That is what ' +
         '<code>int **</code> is. It is how a function changes a caller&rsquo;s <em>pointer</em> (rather than ' +
         'the caller&rsquo;s int), which is how <code>malloc</code>-ing on someone else&rsquo;s behalf works. ' +
         'Count the stars and count the hops: they are the same number.',
  init(m) { m.frame('main'); },
  watch: [
    ['x',     m => m.V('x')],
    ['y',     m => m.V('y')],
    ['p',     m => m.V('p')],
    ['*p',    m => m.D('p')],
    ['pp',    m => m.V('pp')],
    ['*pp',   m => m.D('pp')],
    ['**pp',  m => m.DD('pp')]
  ],
  steps: [
    { line: 7, do: m => { m.scalar('x', 'int', 5); }, say: 'An int.' },
    { line: 8, do: m => { m.scalar('y', 'int', 9); }, say: 'Another int, for later.' },
    { line: 9, do: m => { m.look('x'); m.ptr('p', 'int *', m.ad('x')); },
      say: 'One level: <code>p</code> holds the address of an int.' },
    { line: 10, do: m => { m.look('p'); m.ptr('pp', 'int **', m.ad('p')); },
      say: m => 'Two levels: <code>pp</code> holds <code>' + m.A('p') + '</code>, the address of <code>p</code>. ' +
                'Read the type right to left &mdash; <code>int **pp</code> is "pp is a pointer to a pointer to int". Three boxes, two arrows, and all three boxes are 4 or 8 plain bytes.' },
    { line: 12, do: m => { m.look('x'); m.look('p'); m.look('pp'); m.print('x = ' + m.V('x') + '   *p = ' + m.D('p') + '   **pp = ' + m.DD('pp')); },
      say: 'All three routes reach the same 5: directly, one hop, two hops.' },
    { line: 14, do: m => { m.look('pp'); const pv = m.readAt(m.raw('pp')); m.writeAt(pv, 50); },
      say: '<code>**pp = 50</code> walks the chain: fetch <code>p</code> out of <code>pp</code>, then store into what <code>p</code> points at. Three memory accesses for one assignment.' },
    { line: 15, do: m => { m.look('x'); m.print('x = ' + m.V('x')); }, say: 'x is 50.' },
    { line: 17, do: m => { m.look('pp'); m.look('y'); m.writeAt(m.raw('pp'), m.ad('y')); },
      say: 'One star instead of two, and the target changes completely: <code>*pp = &amp;y</code> overwrites <code>p</code> itself. ' +
           'The middle arrow swings to <code>y</code>; <code>x</code> keeps its 50. This is exactly the mechanism behind <code>int alloc(int **out)</code>-style functions.' },
    { line: 18, do: m => { m.look('p'); m.readAt(m.raw('p')); m.print('*p = ' + m.D('p') + '  (p now aims at y)'); },
      say: 'Following <code>p</code> now lands on <code>y</code>.' },
    { line: 19, do: m => { m.ret(); }, say: 'Frame popped.' }
  ]
},

/* ===================== 7 ===================== */
{
  file: '07_strings.c',
  tab: 'Strings',
  title: 'Char arrays, string literals, and the NUL byte',
  blurb: 'A C string is not a type &mdash; it is a convention: bytes in memory, terminated by <code>\\0</code>. ' +
         'Every library function depends on that byte being there. And there are two very different things that ' +
         'both look like strings in source code: an array you may write, and a literal in read-only memory you may not.',
  init(m) { m.frame('main'); },
  watch: [
    ['buf',         m => m.str('buf')],
    ['&amp;buf[0]', m => m.A('buf')],
    ['lit',         m => m.V('lit')],
    ['*lit',        m => m.D('lit')],
    ['s',           m => m.V('s')],
    ['*s',          m => m.D('s')]
  ],
  steps: [
    { line: 7, do: m => { m.charArray('buf', 'COMS', 6); },
      say: 'Six bytes on the stack, one per character. The initialiser fills four of them with C, O, M, S and ' +
           'zero-fills the rest &mdash; so byte 4 is the NUL terminator that makes these bytes a <em>string</em>, and byte 5 is spare room.' },
    { line: 8, do: m => { const b = m.literal('OS'); m.ptr('lit', 'const char *', b); },
      say: m => 'A completely different arrangement. The characters <code>O</code>, <code>S</code>, <code>\\0</code> are baked into the ' +
                'executable&rsquo;s read-only section at <code>' + m.V('lit') + '</code>, and <code>lit</code> merely points at them. ' +
                'No copy is made. The <code>const</code> is advisory for the compiler; the real enforcement is the page permissions.' },
    { line: 10, do: m => { m.look('buf'); m.print('buf = ' + m.str('buf')); },
      say: '<code>printf("%s")</code> is handed only the <em>address</em> of the first byte. It walks forward printing bytes until it hits a zero. ' +
           'If that zero were missing it would keep walking into whatever lies beyond.' },
    { line: 11, do: m => { m.setIdx('buf', 0, 'R'); },
      say: 'Legal: <code>buf</code> is an array of writable bytes, and we are replacing exactly one of them.' },
    { line: 12, do: m => { m.look('buf'); m.print('buf = ' + m.str('buf')); }, say: 'Now "ROMS".' },
    { line: 14, do: m => { m.look('lit'); m.ro.forEach(r => r.cells.forEach(c => m.focus.add(c.id))); },
      say: 'Commented out for a reason. <code>lit[0] = \'X\'</code> compiles in older dialects and then segfaults at run time, ' +
           'because those bytes are in a read-only page. The lesson: <code>char *s = "hi"</code> gives you a window onto constant data, ' +
           'while <code>char s[] = "hi"</code> gives you a private, writable copy.' },
    { line: 16, do: m => { m.look('buf'); m.ptr('s', 'const char *', m.slot('buf').base); },
      say: 'The idiomatic string walk starts with a pointer at byte 0.' },
    { line: 17, do: m => { m.look('s'); m.readAt(m.raw('s')); m.emit('[' + m.cellAt(m.raw('s')).value + ']'); m.set('s', m.raw('s') + 1); },
      say: m => '<code>*s</code> is <code>\'R\'</code>, not the terminator, so print it and advance. ' +
                'For a <code>char *</code>, <code>s++</code> moves exactly one byte &mdash; <code>sizeof(char)</code> is 1 by definition. ' + walkSay(m) },
    { line: 17, do: m => { m.look('s'); m.readAt(m.raw('s')); m.emit('[' + m.cellAt(m.raw('s')).value + ']'); m.set('s', m.raw('s') + 1); },
      say: m => walkSay(m) },
    { line: 17, do: m => { m.look('s'); m.readAt(m.raw('s')); m.emit('[' + m.cellAt(m.raw('s')).value + ']'); m.set('s', m.raw('s') + 1); },
      say: m => walkSay(m) },
    { line: 17, do: m => { m.look('s'); m.readAt(m.raw('s')); m.emit('[' + m.cellAt(m.raw('s')).value + ']'); m.set('s', m.raw('s') + 1); },
      say: m => walkSay(m) },
    { line: 16, do: m => { m.look('s'); m.readAt(m.raw('s')); },
      say: 'Now <code>*s</code> is <code>\'\\0\'</code>, the condition fails, and the loop stops. Four characters printed from six bytes &mdash; the terminator is data, not decoration. This is also why <code>strlen</code> is O(n): it has to go and look.' },
    { line: 18, do: m => { m.look('lit'); m.emit('\n'); m.print('lit = ' + m.strAt(m.raw('lit'))); },
      say: 'And the literal prints the same way: an address was passed, and printf followed it.' },
    { line: 19, do: m => { m.ret(); },
      say: 'The frame goes away and <code>buf</code> with it. The literal does not &mdash; it is part of the executable image, alive for the whole run. Returning <code>buf</code> from a function would be a bug; returning <code>lit</code> would be fine.' }
  ]
},

/* ===================== 8 ===================== */
{
  file: '08_hazards.c',
  tab: 'Hazards',
  title: 'The four classic pointer bugs',
  blurb: 'Each of these is a valid pointer in the sense that the program compiles and the variable holds a number. ' +
         'What makes three of them wrong is the <em>object at the other end</em>: it never existed, it stopped ' +
         'existing, or it was never written. The watch table spells out what each dereference would actually do.',
  init(m) { m.frame('main'); },
  watch: [
    ['p',  m => m.V('p')],  ['*p', m => m.D('p')],
    ['q',  m => m.V('q')],  ['*q', m => m.D('q')],
    ['r',  m => m.V('r')],  ['*r', m => m.D('r')],
    ['u',  m => m.V('u')],  ['*u', m => m.slot('u') ? 'garbage' : '--']
  ],
  steps: [
    { line: 8, do: m => { m.ptr('p', 'int *', 0); },
      say: '<strong>Bug 1: the NULL dereference.</strong> <code>NULL</code> is a perfectly legitimate value meaning ' +
           '"points at nothing", and you should use it. The bug is only in forgetting to test before following it.' },
    { line: 9, do: m => { m.look('p'); },
      say: 'Address 0 is deliberately left unmapped by the operating system, so <code>*p</code> traps instantly: ' +
           'SIGSEGV, right at the guilty line. Of the four bugs here, this is by far the kindest.' },
    { line: 11, do: m => { const b = m.malloc('malloc(4)', 1, 4); m.ptr('q', 'int *', b); },
      say: 'A four-byte heap block, holding garbage until written.' },
    { line: 12, do: m => { m.look('q'); m.writeAt(m.raw('q'), 5); }, say: 'Written through <code>q</code>: fine, we own this block.' },
    { line: 13, do: m => { m.look('q'); m.free(m.raw('q')); m.mark('q', 'danger'); },
      say: '<strong>Bug 2: the dangling pointer.</strong> <code>free</code> returns the block but does not touch <code>q</code>, ' +
           'which still holds the address. The block is drawn in red because it is no longer ours.' },
    { line: 14, do: m => { m.look('q'); },
      say: 'Writing <code>*q = 6</code> now corrupts whatever the allocator has since put there &mdash; possibly nothing, possibly another object. ' +
           'It usually does not crash, which is the problem: the damage surfaces later, somewhere else. (Freeing twice is the same family of bug.)' },
    { line: 16, do: m => { m.pad(4); m.array('a', 'int[3]', [1, 2, 3]); },
      say: 'A three-element array. (The four grey bytes above it are alignment padding the compiler inserted &mdash; convenient here, because it means nothing of ours sits immediately after the array.)' },
    { line: 17, do: m => { m.look('a'); m.ptr('r', 'int *', m.slot('a').base + 12); m.mark('r', 'danger'); },
      say: m => '<strong>Bug 3: one past the end.</strong> <code>a + 3</code> is <code>' + m.V('r') + '</code>, just past the last element. ' +
                'Forming this pointer is explicitly legal &mdash; it is what makes <code>for (p = a; p &lt; a + 3; p++)</code> work &mdash; and comparing it is legal too.' },
    { line: 18, do: m => { m.look('r'); },
      say: 'Dereferencing it is not. There is no object at that address, so the standard says nothing about what happens. ' +
           'Note how little the pointer tells you: the number looks as reasonable as any other.' },
    { line: 20, do: m => { m.scalar('uninit', 'int', undefined); },
      say: '<strong>Bug 4: the uninitialised pointee.</strong> An <code>int</code> with no initialiser: the four bytes contain whatever was last there.' },
    { line: 21, do: m => { m.look('uninit'); m.ptr('u', 'int *', m.ad('uninit')); },
      say: 'And now a pointer that is valid in every respect &mdash; right type, live object, correct address. ' +
           'Reading <code>*u</code> is still undefined behaviour, because the <em>object</em> has no value yet. The pointer is innocent.' },
    { line: 23, do: m => { m.look('p'); m.print('p = ' + m.V('p').replace('NULL', '0x0') + ' (NULL)'); },
      say: 'Printing a pointer with <code>%p</code> is always safe &mdash; you are reading the pointer, not following it.' },
    { line: 24, do: m => { m.look('r'); m.print('r = ' + m.V('r') + ' (one past a[2], do not deref)'); },
      say: 'Same here: the number is fine to look at.' },
    { line: 25, do: m => { m.look('u'); m.print('u = ' + m.V('u') + ' (points at an uninitialised int)'); },
      say: 'Run this under <code>-fsanitize=address,undefined</code> or Valgrind and the three real bugs are reported the moment they execute. That is the practical advice: the compiler cannot see them, but the sanitizers can.' },
    { line: 26, do: m => { m.ret(); },
      say: 'main returns &mdash; and the heap block from line 11 was freed, so this program leaks nothing.' }
  ]
}

];

/* ------------------------------------------------------------------
 * Rendering and playback
 * ------------------------------------------------------------------ */
let exI = 0;        /* which example            */
let stepI = -1;     /* -1 = nothing has run yet */
let playing = false;
let timer = null;
let mem = null;

const ex = () => EXAMPLES[exI];
const srcLines = () => SOURCES[ex().file].split('\n');

/* Replay the trace from scratch every time. Stepping backwards is then
 * free and cannot drift from stepping forwards. */
function build(upto) {
  const m = new Mem();
  ex().init(m);
  m.changed.clear(); m.focus.clear();
  for (let i = 0; i <= upto; i++) {
    m.changed.clear(); m.focus.clear();
    const st = ex().steps[i];
    if (st && st.do) st.do(m);
  }
  return m;
}
const sayOf = (st, m) => (typeof st.say === 'function' ? st.say(m) : st.say);

function renderCode() {
  const st = stepI >= 0 ? ex().steps[stepI] : null;
  const hot = st ? (Array.isArray(st.line) ? st.line : [st.line]) : [];
  document.getElementById('code').innerHTML = srcLines().map((l, i) => {
    const n = i + 1;
    return '<div class="code-line' + (hot.indexOf(n) >= 0 ? ' active' : '') + '">' +
           '<span class="ln">' + n + '</span><span>' + highlight(l) + '</span></div>';
  }).join('');
}

function renderNote(m) {
  const el = document.getElementById('note');
  const last = stepI === ex().steps.length - 1;
  el.className = 'note' + (last ? ' done' : '');
  if (stepI < 0) {
    el.innerHTML = '<em style="color:var(--muted)">Press <b>Run</b> to execute the program line by line, ' +
                   'or <b>Step</b> to advance one line at a time.</em>';
  } else {
    el.innerHTML = sayOf(ex().steps[stepI], m);
  }
}

function renderWatch(m) {
  const prev = stepI > 0 ? build(stepI - 1) : (stepI === 0 ? build(-1) : null);
  document.getElementById('watch').innerHTML = ex().watch.map(w => {
    const v = typeof w[1] === 'function' ? w[1](m) : w[1];
    const p = prev && typeof w[1] === 'function' ? w[1](prev) : v;
    const flash = String(v) !== String(p);
    return '<tr' + (flash ? ' class="flash"' : '') + '><td class="expr">' + w[0] +
           '</td><td class="val">' + v + '</td></tr>';
  }).join('');
}

function renderConsole(m) {
  const f = ex().file, bin = f.slice(0, 2);
  document.getElementById('console').innerHTML =
    '<span class="shell">$ gcc -Wall -std=c11 ' + f + ' -o ' + bin + ' &amp;&amp; ./' + bin + '</span>\n' +
    esc(m.text) + '<span class="cursor"></span>';
}

function cellHTML(c, m) {
  let cls = 'cell' + (c.vk === 'ptr' ? ' ptr' : '');
  if (m.changed.has(c.id)) cls += ' changed';
  else if (m.focus.has(c.id)) cls += ' focus';
  if (c.flags.danger || c.flags.freed) cls += ' danger';

  let pill = '';
  if (c.vk === 'ptr') {
    if (c.value === 0) pill = '<span class="pill null">null</span>';
    else {
      const b = m.blockAt(c.value);
      if (b && b.freed) pill = '<span class="pill dang">dangling</span>';
      else if (!m.cellAt(c.value)) pill = '<span class="pill oob">no object</span>';
    }
  } else if (c.value === undefined) {
    pill = '<span class="pill junk">uninitialised</span>';
  } else if (c.flags.ro) {
    pill = '<span class="pill ro">read-only</span>';
  }
  const idx = c.idx !== undefined ? '<span class="idx">[' + c.idx + ']</span>' : '';
  return '<div class="' + cls + '" id="cell-' + c.id + '">' +
         '<span class="addr">' + hexa(c.addr) + '</span>' +
         '<span class="val">' + idx + fmt(c) + pill + '</span></div>';
}

function bytesHTML(cells, m) {
  return '<div class="bytes">' + cells.map(c => {
    let cls = 'byte' + (c.value === NUL ? ' nul' : '');
    if (m.changed.has(c.id)) cls += ' changed';
    else if (m.focus.has(c.id)) cls += ' focus';
    const lo = (c.addr & 0xff).toString(16).padStart(2, '0');
    return '<div class="' + cls + '" id="cell-' + c.id + '">' +
           '<span class="b-ch">' + esc(c.value === NUL ? '\\0' : c.value) + '</span>' +
           '<span class="b-ad">&hellip;' + lo + '</span></div>';
  }).join('') + '</div>';
}

function slotHTML(s, m) {
  const size = s.cells.reduce((a, c) => a + c.size, 0);
  const label = '<div class="slot-label"><span class="nm">' + s.name + '</span> &middot; ' +
                esc(s.type) + ' &middot; ' + size + ' byte' + (size === 1 ? '' : 's') + '</div>';
  const body = s.kind === 'bytes' ? bytesHTML(s.cells, m)
                                  : s.cells.map(c => cellHTML(c, m)).join('');
  return '<div class="slot">' + label + body + '</div>';
}

function renderMem(m) {
  let h = '';

  h += '<div class="region r-stack"><div class="region-head"><i class="dot"></i>stack' +
       '<span class="grow">high addresses on top &middot; grows downward &darr;</span></div>';
  if (!m.frames.length) {
    h += '<div class="empty">(no frames &mdash; the program has not started, or main has returned)</div>';
  }
  m.frames.forEach((f, i) => {
    const top = i === m.frames.length - 1;
    h += '<div class="frame' + (top ? ' top' : '') + '"><div class="frame-head">' + f.fn + '()' +
         '<span class="badge">' + (top ? 'executing' : 'waiting') + '</span></div>';
    h += f.slots.length ? f.slots.map(s => slotHTML(s, m)).join('')
                        : '<div class="empty">(no locals yet)</div>';
    h += '</div>';
  });
  h += '</div>';

  if (m.blocks.length) {
    h += '<div class="region r-heap"><div class="region-head"><i class="dot"></i>heap' +
         '<span class="grow">malloc &middot; grows upward &uarr;</span></div>';
    m.blocks.forEach(b => {
      const bytes = b.cells.length * b.es;
      h += '<div class="block' + (b.freed ? ' freed' : '') + '"><div class="block-head">' +
           b.label + ' @ ' + hexa(b.base) +
           '<span class="badge">' + (b.freed ? 'freed &mdash; not yours' : bytes + ' bytes, live') +
           '</span></div>' + b.cells.map(c => cellHTML(c, m)).join('') + '</div>';
    });
    h += '</div>';
  }

  if (m.ro.length) {
    h += '<div class="region r-ro"><div class="region-head"><i class="dot"></i>read-only data' +
         '<span class="grow">part of the executable &middot; not writable</span></div>';
    m.ro.forEach(r => {
      h += '<div class="slot"><div class="slot-label"><span class="nm">' + esc(r.label) +
           '</span> &middot; string literal &middot; ' + r.cells.length + ' bytes</div>' +
           bytesHTML(r.cells, m) + '</div>';
    });
    h += '</div>';
  }

  document.getElementById('mem').innerHTML = h;
  document.getElementById('memTag').textContent =
    'stack ' + hexa(STACK_TOP) + ' ↓   heap ' + hexa(HEAP_BASE) + ' ↑';
}

function drawArrows(m) {
  const svg = document.getElementById('arrows');
  const wrap = document.getElementById('memwrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const wr = wrap.getBoundingClientRect();

  const mk = (id, col) => '<marker id="' + id + '" viewBox="0 0 10 10" refX="9" refY="5" ' +
    'markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="' + col + '"/></marker>';
  let out = '<defs>' + mk('ah-ok', '#38bdf8') + mk('ah-hot', '#fbbf24') + mk('ah-bad', '#f87171') + '</defs>';

  const ptrs = [];
  const collect = cells => cells.forEach(c => { if (c.vk === 'ptr' && c.value) ptrs.push(c); });
  m.frames.forEach(f => f.slots.forEach(s => collect(s.cells)));
  m.blocks.forEach(b => collect(b.cells));

  ptrs.forEach((c, i) => {
    const src = document.getElementById('cell-' + c.id);
    const tc = m.cellAt(c.value);
    if (!src || !tc) return;
    const tgt = document.getElementById('cell-' + tc.id);
    if (!tgt) return;

    const a = src.getBoundingClientRect(), b = tgt.getBoundingClientRect();
    const x0 = a.right - wr.left, y0 = a.top - wr.top + a.height / 2;
    const x1 = b.right - wr.left, y1 = b.top - wr.top + b.height / 2;
    const lane = W - 8 - (i % 3) * 12;

    const blk = m.blockAt(c.value);
    const bad = (blk && blk.freed) || c.flags.danger;
    const hot = m.changed.has(c.id);
    const col = bad ? '#f87171' : hot ? '#fbbf24' : '#38bdf8';
    const arrow = bad ? 'ah-bad' : hot ? 'ah-hot' : 'ah-ok';
    const dash = bad ? ' stroke-dasharray="5 4"' : '';

    out += '<circle cx="' + x0 + '" cy="' + y0 + '" r="2.5" fill="' + col + '"/>' +
           '<path d="M' + x0 + ' ' + y0 + ' C' + lane + ' ' + y0 + ', ' + lane + ' ' + y1 +
           ', ' + (x1 + 7) + ' ' + y1 + '" fill="none" stroke="' + col +
           '" stroke-width="1.6" marker-end="url(#' + arrow + ')"' + dash + ' opacity="0.92"/>';
  });
  svg.innerHTML = out;
}

function render() {
  mem = build(stepI);
  renderCode();
  renderNote(mem);
  renderWatch(mem);
  renderConsole(mem);
  renderMem(mem);
  drawArrows(mem);

  syncHash();
  document.getElementById('stepNow').textContent = stepI + 1;
  document.getElementById('stepMax').textContent = ex().steps.length;
  document.getElementById('backBtn').disabled = stepI < 0;
  document.getElementById('stepBtn').disabled = stepI >= ex().steps.length - 1;
  document.getElementById('runBtn').innerHTML = playing ? '&#10073;&#10073;&nbsp; Pause' : '&#9654;&nbsp; Run';
}

/* ---------------- deep links ----------------
 * The URL carries "#example/step" so a particular moment can be linked to
 * directly -- handy for pointing a class at one slide of the walkthrough. */
function syncHash() {
  try {
    history.replaceState(null, '', '#' + (exI + 1) + '/' + (stepI + 1));
  } catch (e) { /* file:// forbids replaceState; harmless */ }
}
function fromHash() {
  const m = /^#(\d+)(?:\/(\d+))?$/.exec(location.hash || '');
  if (!m) return false;
  const i = +m[1] - 1;
  if (!(i >= 0 && i < EXAMPLES.length)) return false;
  exI = i;
  const s = m[2] === undefined ? 0 : +m[2];
  stepI = Math.max(-1, Math.min(s - 1, EXAMPLES[i].steps.length - 1));
  return true;
}

/* ---------------- playback ---------------- */
function stop() {
  playing = false;
  if (timer) { clearInterval(timer); timer = null; }
}
function step() {
  if (stepI >= ex().steps.length - 1) { stop(); render(); return false; }
  stepI++; render();
  return true;
}
function play() {
  if (stepI >= ex().steps.length - 1) stepI = -1;   /* replay from the top */
  stop();
  playing = true;
  const ms = +document.getElementById('speed').value;
  timer = setInterval(() => { if (!step()) stop(); }, ms);
  render();
}
function toggleRun() { playing ? (stop(), render()) : play(); }

function loadExample(i, keepStep) {
  stop();
  exI = i;
  if (!keepStep) stepI = -1;
  document.getElementById('lessonTitle').textContent = ex().title;
  document.getElementById('lessonText').innerHTML = ex().blurb;
  document.getElementById('fileName').textContent = 'code/' + ex().file;
  [...document.querySelectorAll('.tab')].forEach((t, k) => {
    t.className = 'tab' + (k === i ? ' active' : '');
  });
  render();
}

/* ---------------- wiring ---------------- */
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('tabs').innerHTML = EXAMPLES.map((e, i) =>
      '<button class="tab" data-i="' + i + '"><span class="num">' +
      e.file.slice(0, 2) + '</span>' + e.tab + '</button>').join('');
    document.getElementById('tabs').addEventListener('click', e => {
      const t = e.target.closest('.tab');
      if (t) loadExample(+t.dataset.i);
    });

    document.getElementById('runBtn').addEventListener('click', toggleRun);
    document.getElementById('stepBtn').addEventListener('click', () => { stop(); step(); });
    document.getElementById('backBtn').addEventListener('click', () => {
      stop(); if (stepI >= 0) { stepI--; render(); }
    });
    document.getElementById('resetBtn').addEventListener('click', () => {
      stop(); stepI = -1; render();
    });
    document.getElementById('speed').addEventListener('input', () => { if (playing) play(); });
    document.getElementById('copyBtn').addEventListener('click', e => {
      navigator.clipboard.writeText(SOURCES[ex().file] + '\n').then(() => {
        const b = e.target; b.textContent = 'Copied ✓';
        setTimeout(() => { b.textContent = 'Copy C source'; }, 1400);
      });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { stop(); step(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { stop(); if (stepI >= 0) { stepI--; render(); } e.preventDefault(); }
      else if (e.key === ' ') { toggleRun(); e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') { stop(); stepI = -1; render(); }
    });
    window.addEventListener('resize', () => { if (mem) drawArrows(mem); });

    const deep = fromHash();
    loadExample(exI, deep);

    window.addEventListener('hashchange', () => {
      if (fromHash()) loadExample(exI, true);
    });
  });
}
