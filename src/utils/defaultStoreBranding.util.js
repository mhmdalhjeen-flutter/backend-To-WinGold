/** صور افتراضية حسب نوع نشاط المتجر — SVG مضمّنة بدون اعتماد خارجي */

const PRESETS = [
  {
    keywords: ['مطعم', 'مأكول', 'restaurant', 'food', 'burger', 'pizza', 'shawarma', 'شاورما'],
    label: 'مطعم',
    emoji: '🍽️',
    logo: ['#ea580c', '#c2410c'],
    cover: ['#9a3412', '#ea580c'],
  },
  {
    keywords: ['صيدل', 'دواء', 'pharmacy', 'medic'],
    label: 'صيدلية',
    emoji: '💊',
    logo: ['#059669', '#047857'],
    cover: ['#065f46', '#10b981'],
  },
  {
    keywords: ['ملابس', 'أزياء', 'fashion', 'cloth', 'boutique'],
    label: 'ملابس',
    emoji: '👕',
    logo: ['#7c3aed', '#5b21b6'],
    cover: ['#4c1d95', '#8b5cf6'],
  },
  {
    keywords: ['حلو', 'معجن', 'حلى', 'sweets', 'bakery', 'cake'],
    label: 'حلويات',
    emoji: '🍰',
    logo: ['#db2777', '#be185d'],
    cover: ['#9d174d', '#ec4899'],
  },
  {
    keywords: ['سيار', 'car', 'auto', 'vehicle', 'مرك'],
    label: 'سيارات',
    emoji: '🚗',
    logo: ['#2563eb', '#1d4ed8'],
    cover: ['#1e3a8a', '#3b82f6'],
  },
  {
    keywords: ['إلكترون', 'electron', 'tech', 'mobile', 'phone'],
    label: 'إلكترونيات',
    emoji: '📱',
    logo: ['#0891b2', '#0e7490'],
    cover: ['#155e75', '#06b6d4'],
  },
  {
    keywords: ['سوبر', 'بقال', 'grocery', 'market', 'خضار'],
    label: 'بقالة',
    emoji: '🛒',
    logo: ['#16a34a', '#15803d'],
    cover: ['#14532d', '#22c55e'],
  },
  {
    keywords: ['مستود', 'supplier', 'جمل', 'wholesale'],
    label: 'مستودع',
    emoji: '🏬',
    logo: ['#475569', '#334155'],
    cover: ['#1e293b', '#64748b'],
  },
];

const FALLBACK = {
  label: 'متجر',
  emoji: '🏪',
  logo: ['#2563eb', '#1e40af'],
  cover: ['#1e3a8a', '#3b82f6'],
};

const svgDataUrl = (width, height, colors, emoji, subtitle = '') => {
  const [c1, c2] = colors;
  const fontSize = Math.round(width * (width > 300 ? 0.12 : 0.28));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="50%" y="${subtitle ? '42%' : '54%'}" text-anchor="middle" font-size="${fontSize}" fill="#ffffff">${emoji}</text>
${subtitle ? `<text x="50%" y="72%" text-anchor="middle" font-size="${Math.round(fontSize * 0.45)}" fill="rgba(255,255,255,0.9)" font-family="Arial,sans-serif">${subtitle}</text>` : ''}
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const matchPreset = (category) => {
  const text = (category || '').toLowerCase().trim();
  if (!text) return FALLBACK;
  for (const preset of PRESETS) {
    if (preset.keywords.some((k) => text.includes(k.toLowerCase()))) return preset;
  }
  return FALLBACK;
};

const getDefaultBrandingForCategory = (category) => {
  const preset = matchPreset(category);
  return {
    label: preset.label,
    emoji: preset.emoji,
    logo: svgDataUrl(256, 256, preset.logo, preset.emoji),
    cover: svgDataUrl(900, 280, preset.cover, preset.emoji, preset.label),
  };
};

module.exports = { getDefaultBrandingForCategory, matchPreset };
