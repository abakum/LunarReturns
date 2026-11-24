const defaults = Object.freeze({
    orth: false, islam: false, bud: false, cath: false, jud: false,
    fynny: false, trim: false, gedcom: false, pdf: false, epub: false, html: false, bell: true,
});

function normalizeSettings(raw) {
    let config;
    try { config = JSON.parse(raw); } catch { return { ...defaults }; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { ...defaults };
    return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
        [key, typeof config[key] === 'boolean' ? config[key] : fallback]));
}

function settingPatch(key, value) {
    if (!Object.hasOwn(defaults, key)) throw new RangeError('Unknown chat setting: ' + key);
    const path = '$.' + key;
    const current = "CASE WHEN json_valid(config) THEN CASE WHEN json_type(config) = 'object' THEN config ELSE '{}' END ELSE '{}' END";
    const toggle = value === undefined;
    const initial = JSON.stringify({ [key]: toggle ? !defaults[key] : value });
    const next = toggle
        ? `CASE json_type(${current}, ?) WHEN 'true' THEN 'false' WHEN 'false' THEN 'true' ELSE ? END`
        : '?';
    return { initial, expression: `json_set(${current}, ?, json(${next}))`,
        params: toggle ? [path, path, String(!defaults[key])] : [path, String(value)] };
}

module.exports = { normalizeSettings, settingPatch };
