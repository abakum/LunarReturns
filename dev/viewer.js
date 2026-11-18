import { createChart, gedcomToJson, HourglassChart, DetailedRenderer } from 'topola';

const input = JSON.parse(document.getElementById('tree-data').textContent);
const select = document.getElementById('person');
const status = document.getElementById('status');
const svg = document.getElementById('tree');
const group = document.getElementById('chart');
const annotation = document.getElementById('annotation');
const annotationText = document.getElementById('annotation-text');
function closeAnnotation() {
    annotation.hidden = true;
}
function showAnnotation(id, node) {
    const text = input.annotations?.[id] || '\nНет росписи для этой персоны.';
    const newline = text.indexOf('\n');
    document.getElementById('annotation-heading').textContent = text.slice(0, newline);
    annotationText.textContent = text.slice(newline + 1);
    annotation.hidden = false;
    const rect = node.getBoundingClientRect();
    const width = annotation.offsetWidth, height = annotation.offsetHeight;
    annotation.style.left = Math.max(12, Math.min(rect.left, innerWidth - width - 12)) + 'px';
    annotation.style.top = Math.max(12, Math.min(rect.bottom + 8, innerHeight - height - 12)) + 'px';
}
document.addEventListener('pointerdown', event => {
    if (!annotation.contains(event.target) && !event.target.closest('#chart .indi')) closeAnnotation();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAnnotation(); });
let size = [1, 1], scale = 1, x = 0, y = 0;
function transform() { group.setAttribute('transform', `translate(${x},${y}) scale(${scale})`); }
function fit() {
    scale = Math.min(svg.clientWidth / size[0], svg.clientHeight / size[1], 1) * 0.95;
    x = (svg.clientWidth - size[0] * scale) / 2;
    y = (svg.clientHeight - size[1] * scale) / 2;
    transform();
}
function zoom(factor, cx = svg.clientWidth / 2, cy = svg.clientHeight / 2) {
    const next = Math.max(0.01, Math.min(5, scale * factor));
    x = cx - (cx - x) * next / scale;
    y = cy - (cy - y) * next / scale;
    scale = next;
    transform();
}
try {
    // Refuse oversized inputs explicitly instead of silently dropping relatives.
    if (new TextEncoder().encode(input.gedcom).length > 8 * 1024 * 1024 || (input.gedcom.match(/^0 @[^\r\n]+@ INDI\r?$/gm) || []).length > 1000)
        throw new Error('Для просмотра поддерживается до 1000 персон и 8 МиБ текста GEDCOM. Выберите меньший фрагмент в боте.');
    const data = gedcomToJson(input.gedcom);
    // Strip display-only fields before Topola measures cards. The original GEDCOM stays embedded.
    for (const person of data.indis) {
        delete person.images;
        for (const event of [person.birth, person.death, ...(person.events || [])]) if (event) delete event.place;
        const option = document.createElement('option');
        option.value = person.id;
        const birth = person.birth?.date?.year || '';
        option.textContent = [person.firstName, person.lastName, birth, '(' + person.id + ')'].filter(Boolean).join(' ');
        select.append(option);
    }
    for (const family of data.fams) if (family.marriage) delete family.marriage.place;
    if (!data.indis.length) throw new Error('В файле нет персон.');
    const chart = createChart({ json: data, chartType: HourglassChart, renderer: DetailedRenderer,
        svgSelector: '#chart', animate: false, updateSvgSize: false, locale: 'ru', expanders: false,
        indiCallback: info => { select.value = info.id; render(); } });
    function render() {
        try {
            closeAnnotation();
            for (const link of group.querySelectorAll('a.name-link')) link.replaceWith(...link.childNodes);
            group.removeAttribute('transform');
            const info = chart.render({ startIndi: select.value });
            size = info.size;
            for (const node of group.querySelectorAll('.indi')) {
                for (const text of node.querySelectorAll('text.name')) {
                    const link = document.createElementNS('http://www.w3.org/2000/svg', 'a');
                    link.setAttribute('href', '#annotation');
                    link.setAttribute('class', 'name-link');
                    link.setAttribute('aria-label', 'Роспись: ' + text.textContent);
                    // Raise names above Topola's transparent click border.
                    node.append(link);
                    link.append(text);
                    link.onclick = event => {
                        event.preventDefault(); event.stopPropagation();
                        showAnnotation(node.__data__.indi.id, node);
                    };
                }
            }
            fit();
            status.textContent = '';
        } catch (error) { status.textContent = 'Не удалось построить дерево: ' + error.message; }
    }
    select.value = data.indis.some(p => p.id === input.heroXref) ? input.heroXref : data.indis[0].id;
    select.addEventListener('change', render);
    document.getElementById('fit').onclick = fit;
    document.getElementById('plus').onclick = () => zoom(1.3);
    document.getElementById('minus').onclick = () => zoom(1 / 1.3);
    svg.addEventListener('wheel', event => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        zoom(Math.exp(-event.deltaY * 0.001), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    const pointers = new Map();
    let dragged = false, origin;
    svg.addEventListener('pointerdown', event => {
        if (!pointers.size) { dragged = false; origin = [event.clientX, event.clientY]; }
        pointers.set(event.pointerId, [event.clientX, event.clientY]);
        event.target.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
        const old = pointers.get(event.pointerId);
        if (!old) return;
        if (pointers.size > 1 || Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 5) { dragged = true; closeAnnotation(); }
        if (pointers.size === 1) { x += event.clientX - old[0]; y += event.clientY - old[1]; transform(); }
        else {
            const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
            const before = Math.hypot(old[0] - other[0], old[1] - other[1]);
            const after = Math.hypot(event.clientX - other[0], event.clientY - other[1]);
            const rect = svg.getBoundingClientRect();
            if (before) zoom(after / before, (event.clientX + other[0]) / 2 - rect.left, (event.clientY + other[1]) / 2 - rect.top);
        }
        pointers.set(event.pointerId, [event.clientX, event.clientY]);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) svg.addEventListener(name, e => pointers.delete(e.pointerId));
    svg.addEventListener('click', event => {
        if (dragged) { event.stopPropagation(); event.preventDefault(); }
    }, true);
    window.addEventListener('resize', fit);
    render();
} catch (error) { status.textContent = 'Не удалось открыть дерево: ' + error.message; }
