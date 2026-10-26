// LaTeX -> Unicode converter so math renders on ALL Telegram clients
// (Telegram does not reliably render raw LaTeX from bot messages)

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  theta: 'θ', lambda: 'λ', mu: 'μ', nu: 'ν', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
};

const OPS = {
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓',
  leq: '≤', geq: '≥', neq: '≠', approx: '≈', equiv: '≡',
  infty: '∞', partial: '∂', nabla: '∇', degree: '°', circ: '°',
  rightarrow: '→', leftarrow: '←', to: '→', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔',
  sum: 'Σ', prod: 'Π', int: '∫', cap: '∩', cup: '∪',
  in: '∈', notin: '∉', subset: '⊂', cupleft: '∪', forall: '∀', exists: '∃',
};

const SUP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵',
  '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻',
  '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', 'o': '°',
};

const SUB = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅',
  '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋',
  '=': '₌', 'n': 'ₙ', 'i': 'ᵢ', 'x': 'ₓ', 'e': 'ₑ',
};

const PUNCT = {
  ',': ',', '.': '.', ':': ':', ';': ';', '!': '!', '?': '?',
};

function toScripted(str, map) {
  return [...str].map((ch) => map[ch] || ch).join('');
}

// \frac{a}{b} -> a/b (one nesting level; repeat for nested)
function convertFractions(s) {
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\d?frac\{([^{}]+)\}\{([^{}]+)\}/g, (_, top, bot) => {
      const wrap = (t) => (/^[-+]?[A-Za-z0-9]+([A-Za-z]*)$/.test(t) ? t : `(${t})`);
      return `${wrap(top)}/${wrap(bot)}`;
    });
  }
  return s;
}

function convertSymbols(s) {
  for (const [k, v] of Object.entries(GREEK)) {
    s = s.split(`\\${k}`).join(v);
  }
  for (const [k, v] of Object.entries(OPS)) {
    s = s.split(`\\${k}`).join(v);
  }
  s = s
    .replace(/\^\s*\\circ\b/g, '°')
    .replace(/\\sqrt\s*(\[[^\]]*\])?\s*\{([^{}]+)\}/g, (_, __, arg) => `√(${arg})`)
    .replace(/\\sqrt\s+([A-Za-z0-9]+)/g, (_, arg) => `√${arg}`)
    .replace(/\\left|\\right/g, '');
  return s;
}

function convertScripts(s) {
  // ^{...} or ^x -> superscript; _{...} or _x -> subscript
  s = s.replace(/\^\{([^{}]+)\}/g, (_, m) => toScripted(convertSymbols(m), SUP))
       .replace(/\^(\\[A-Za-z]+|[A-Za-z0-9]+)/g, (_, m) => toScripted(convertSymbols(m), SUP))
       .replace(/_\{([^{}]+)\}/g, (_, m) => toScripted(convertSymbols(m), SUB))
       .replace(/_([A-Za-z0-9]+)/g, (_, m) => toScripted(m, SUB));
  return s;
}

function convertCommonEnvs(s) {
  // \text{...} or \mathrm{...} -> raw text
  for (let i = 0; i < 2; i++) {
    s = s.replace(/\\(text|mathrm)\{([^{}]*)\}/g, '$2');
  }
  return s;
}

function latexToUnicode(text) {
  if (!text) return text || '';
  let s = text;
  // Skip transformation unless LaTeX delimiters or backslash commands exist
  const hasLaTeX = /\\(d?frac|sqrt|left|right|text|mathrm)|\\[A-Za-z]+|\$|\\\(|\\\[/.test(s);
  if (!hasLaTeX) return text;

  s = convertCommonEnvs(s);
  s = convertFractions(s);
  s = convertSymbols(s);
  s = convertScripts(s);

  s = s
    .replace(/\$\$([^$]+)\$\$/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/\\\((.+?)\\\)/gs, '$1')
    .replace(/\\\[([\s\S]+?)\\\]/g, '$1')
    .replace(/\\\\/g, ', ')
    .replace(/\\,|\\;|\\:|\\!/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\\begin\{[a-z*]+\}/g, '')
    .replace(/\\end\{[a-z*]+\}/g, '')
    .replace(/\\hline/g, '')
    .replace(/\\([A-Za-z]{2,})/g, ' $1 ')
    .replace(/ ([₀-₉⁰-⁹°²³⁴⁵⁶⁷⁸⁹]) /g, '$1')
    .replace(/\s*\^\s*(°)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

module.exports = { latexToUnicode };
