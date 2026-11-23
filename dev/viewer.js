import { createChart, gedcomToJson, HourglassChart, DetailedRenderer } from 'topola';

const input = JSON.parse(document.getElementById('tree-data').textContent);
const search = document.getElementById('person');
const results = document.getElementById('person-results');
const status = document.getElementById('status');
const svg = document.getElementById('tree');
const group = document.getElementById('chart');
const annotation = document.getElementById('annotation');
const annotationText = document.getElementById('annotation-text');
const lifeView = document.getElementById('life-view');
const showingLife = () => lifeView && !lifeView.hidden;
function closeAnnotation() {
    annotation.hidden = true;
}
function showAnnotation(id, node, people, navigate, onChart = false) {
    const rows = Object.hasOwn(input.annotations ?? {}, id) ? input.annotations[id] : [];
    annotationText.replaceChildren();
    for (const [i, { text, hero, xref, kinship, links, prefix = '' }] of rows.entries()) {
        if (i) annotationText.append('\n');
        if (prefix) annotationText.append(prefix);
        if (hero || links?.length) {
            const container = hero ? document.createElement('strong') : annotationText;
            let offset = 0;
            for (const { start, end, href } of links || []) {
                container.append(text.slice(offset, start));
                const link = document.createElement('a');
                link.href = href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = text.slice(start, end);
                container.append(link);
                offset = end;
            }
            container.append(text.slice(offset));
            if (hero) annotationText.append(container);
        } else if (people.has(xref)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'relative-button';
            button.textContent = text;
            button.onclick = () => navigate(xref, true);
            annotationText.append(button);
        } else annotationText.append(text);
        if (kinship) annotationText.append(' · ' + kinship);
    }
    if (!rows.length) annotationText.textContent = 'Нет росписи для этой персоны.';
    annotation.hidden = false;
    annotation.scrollTop = 0;
    annotation.style.maxWidth = '';
    annotation.style.maxHeight = '';
    const rect = node.getBoundingClientRect();
    if (onChart) {
        const gap = 12;
        if (!node.hasAttribute('data-bar') && !node.hasAttribute('data-row')) {
            const childPoint = node.hasAttribute('data-child-point') || node.hasAttribute('data-parent-point');
            const sideGap = childPoint ? 0 : gap;
            const rightStart = Math.max(gap, rect.right + sideGap);
            const leftEnd = Math.min(innerWidth - gap, rect.left - sideGap);
            const right = innerWidth - rightStart - gap;
            const left = leftEnd - gap;
            const useRight = right >= 200 || right >= left;
            annotation.style.maxWidth = `${Math.max(0, useRight ? right : left)}px`;
            annotation.style.left = `${useRight ? rightStart : Math.max(gap, leftEnd - annotation.getBoundingClientRect().width)}px`;
            if (childPoint) {
                annotation.style.maxHeight = `min(65vh, 600px, ${Math.max(0, innerHeight - rect.bottom)}px)`;
                annotation.style.top = `${rect.bottom}px`;
            } else {
                annotation.style.top = `${Math.max(gap, Math.min(rect.top, innerHeight - annotation.offsetHeight - gap))}px`;
            }
        } else {
            const below = Math.max(gap, rect.bottom + gap);
            const above = Math.min(innerHeight - gap, rect.top - gap);
            const useBelow = innerHeight - gap - below >= 100 || innerHeight - below >= above;
            const room = useBelow ? innerHeight - gap - below : above - gap;
            annotation.style.maxHeight = `min(65vh, 600px, ${Math.max(0, room)}px)`;
            annotation.style.left = `${Math.max(gap, Math.min(rect.left, innerWidth - annotation.offsetWidth - gap))}px`;
            annotation.style.top = `${useBelow ? below : above - annotation.offsetHeight}px`;
        }
        return;
    }
    const width = annotation.offsetWidth, height = annotation.offsetHeight;
    annotation.style.left = Math.max(12, Math.min(rect.left, innerWidth - width - 12)) + 'px';
    annotation.style.top = Math.max(12, Math.min(rect.bottom + 8, innerHeight - height - 12)) + 'px';
}
document.addEventListener('pointerdown', event => {
    if (!annotation.contains(event.target) && !event.target.closest('#chart .indi, #life-targets rect')) closeAnnotation();
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
function gestures(view, zoomAt, pan) {
    view.addEventListener('wheel', event => {
        event.preventDefault();
        closeAnnotation();
        const rect = view.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.001), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    const pointers = new Map();
    let dragged = false, origin;
    view.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        if (!pointers.size) { dragged = false; origin = [event.clientX, event.clientY]; }
        pointers.set(event.pointerId, [event.clientX, event.clientY]);
        event.target.setPointerCapture(event.pointerId);
    });
    view.addEventListener('pointermove', event => {
        const old = pointers.get(event.pointerId);
        if (!old) return;
        const dx = event.clientX - old[0], dy = event.clientY - old[1];
        if (pointers.size > 1 || Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 5) { dragged = true; closeAnnotation(); }
        if (pointers.size === 1) pan(dx, dy);
        else {
            const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
            const before = Math.hypot(old[0] - other[0], old[1] - other[1]);
            const after = Math.hypot(event.clientX - other[0], event.clientY - other[1]);
            const rect = view.getBoundingClientRect();
            pan(dx / 2, dy / 2);
            if (before) zoomAt(after / before, (event.clientX + other[0]) / 2 - rect.left, (event.clientY + other[1]) / 2 - rect.top);
        }
        pointers.set(event.pointerId, [event.clientX, event.clientY]);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) view.addEventListener(name, e => pointers.delete(e.pointerId));
    view.addEventListener('click', event => {
        if (dragged && event.detail) { event.stopPropagation(); event.preventDefault(); }
    }, true);
}
try {
    // Refuse oversized inputs explicitly instead of silently dropping relatives.
    if ((input.gedcom.match(/^0 @[^\r\n]+@ INDI\r?$/gm) || []).length > 10000)
        throw new Error('Для просмотра поддерживается до 10 000 персон. Выберите меньший фрагмент в боте.');
    const data = gedcomToJson(input.gedcom);
    const people = new Map();
    const normalize = text => text.toLocaleLowerCase('ru').replace(/ё/g, 'е');
    // Strip display-only fields before Topola measures cards. The original GEDCOM stays embedded.
    for (const person of data.indis) {
        delete person.images;
        for (const event of [person.birth, person.death, ...(person.events || [])]) if (event) delete event.place;
        const birth = person.birth?.date?.year || '';
        const label = [person.firstName, person.lastName, birth, '(' + person.id + ')'].filter(Boolean).join(' ');
        people.set(person.id, { id: person.id, label, searchable: normalize(label) });
    }
    for (const family of data.fams) if (family.marriage) delete family.marriage.place;
    if (!data.indis.length) throw new Error('В файле нет персон.');
    const collator = new Intl.Collator('ru', { numeric: true });
    const byLabel = (a, b) => collator.compare(a.label, b.label);
    const sorted = [...people.values()].sort(byLabel);
    const targets = document.getElementById('life-targets');
    const bars = new Map([...(targets?.querySelectorAll('[data-bar]') ?? [])].map(bar => [bar.getAttribute('data-xref'), bar]));
    const lifePeople = new Map([...bars].map(([id, bar]) => {
        const label = [bar.getAttribute('aria-label').slice('Роспись: '.length), bar.getAttribute('data-year'), '(' + id + ')'].filter(Boolean).join(' ');
        return [id, { id, label, searchable: normalize(label) }];
    }));
    const sortedLife = [...lifePeople.values()].sort(byLabel);
    const defaultId = people.has(input.heroXref) ? input.heroXref : data.indis[0].id;
    let currentId, currentBar;
    let fitLife, zoomLife, navigateBar;
    const chart = createChart({ json: data, chartType: HourglassChart, renderer: DetailedRenderer,
        svgSelector: '#chart', animate: false, updateSvgSize: false, locale: 'ru', expanders: false,
        indiCallback: info => { dismissTip(); navigate(info.id); } });
    function render(refocus = false, openAnnotation = false) {
        try {
            closeAnnotation();
            for (const button of group.querySelectorAll('.name-button')) button.replaceWith(...button.childNodes);
            group.removeAttribute('transform');
            const info = chart.render({ startIndi: currentId });
            size = info.size;
            let selected;
            for (const node of group.querySelectorAll('.indi')) {
                const person = node.__data__;
                if ((refocus || openAnnotation) && person.indi.id === currentId && (!selected || person.generation === 0)) selected = node;
                for (const text of node.querySelectorAll('text.name')) {
                    const button = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                    button.setAttribute('class', 'name-button');
                    button.setAttribute('role', 'button');
                    button.setAttribute('tabindex', '0');
                    button.setAttribute('aria-label', 'Роспись: ' + text.textContent);
                    // Raise names above Topola's transparent click border.
                    node.append(button);
                    button.append(text);
                    const open = event => {
                        event.stopPropagation();
                        dismissTip();
                        showAnnotation(node.__data__.indi.id, node, people, navigate);
                    };
                    button.onclick = open;
                    button.onkeydown = event => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (!event.repeat) open(event);
                    };
                }
            }
            const card = refocus && selected?.querySelector('rect.border');
            if (card) {
                const bounds = card.getBoundingClientRect();
                const viewport = svg.getBoundingClientRect();
                x = svg.clientWidth / 2 - (bounds.left + bounds.width / 2 - viewport.left - svg.clientLeft) * scale;
                y = svg.clientHeight / 2 - (bounds.top + bounds.height / 2 - viewport.top - svg.clientTop) * scale;
                transform();
            } else fit();
            if (openAnnotation && selected) showAnnotation(currentId, selected, people, navigate);
            status.textContent = '';
        } catch (error) { status.textContent = 'Не удалось построить дерево: ' + error.message; }
    }
    const tip = document.getElementById('touch-tip');
    const tipKey = 'lunarreturns.viewer.touch-tip-dismissed';
    function dismissTip() {
        if (tip.hidden) return;
        tip.hidden = true;
        try { sessionStorage.setItem(tipKey, '1'); } catch { /* Storage may be disabled for file URLs. */ }
    }
    try { tip.hidden = sessionStorage.getItem(tipKey) === '1'; } catch { tip.hidden = false; }
    tip.querySelector('button').onclick = dismissTip;

    let matches = [], active = -1;
    function closeResults() {
        results.hidden = true;
        search.setAttribute('aria-expanded', 'false');
        search.removeAttribute('aria-activedescendant');
        search.value = (showingLife() ? lifePeople.get(currentBar) : people.get(currentId))?.label ?? '';
    }
    function showResults(query = '') {
        const words = normalize(query).trim().split(/\s+/).filter(Boolean);
        matches = (showingLife() ? sortedLife : sorted).filter(person => words.every(word => person.searchable.includes(word)));
        active = -1;
        search.removeAttribute('aria-activedescendant');
        results.replaceChildren(...matches.map(({ label }, i) => {
            const option = document.createElement('li');
            option.id = 'person-result-' + i;
            option.dataset.index = i;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.textContent = label;
            return option;
        }));
        if (!matches.length) {
            const empty = document.createElement('li');
            empty.setAttribute('role', 'status');
            empty.textContent = 'Никого не найдено';
            results.append(empty);
        }
        results.hidden = false;
        results.scrollTop = 0;
        search.setAttribute('aria-expanded', 'true');
    }
    function showPerson(id, refocus = false, openAnnotation = false) {
        const previousId = currentId;
        currentId = id;
        closeResults();
        if (refocus || previousId !== id) render(previousId !== undefined, openAnnotation);
    }
    function navigate(id, openAnnotation = false) {
        const fragment = '#person=' + encodeURIComponent(id);
        if (id !== currentId && location.hash !== fragment) location.hash = fragment;
        showPerson(id, true, openAnnotation);
    }
    function readFragment() {
        try {
            const fragment = /^#person=(.+)$/.exec(location.hash);
            const id = fragment && decodeURIComponent(fragment[1]);
            if (people.has(id)) return id;
        } catch { /* Ignore malformed fragments. */ }
        return defaultId;
    }
    search.addEventListener('focus', () => { search.select(); showResults(); });
    search.addEventListener('click', () => { if (results.hidden) { search.select(); showResults(); } });
    search.addEventListener('input', () => showResults(search.value));
    search.addEventListener('blur', closeResults);
    search.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (results.hidden) showResults();
            if (!matches.length) return;
            if (active !== -1) results.children[active].setAttribute('aria-selected', 'false');
            active = event.key === 'ArrowDown' ? Math.min(active + 1, matches.length - 1)
                : active === -1 ? matches.length - 1 : Math.max(active - 1, 0);
            const option = results.children[active];
            option.setAttribute('aria-selected', 'true');
            search.setAttribute('aria-activedescendant', option.id);
            option.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && !results.hidden && matches.length) {
            event.preventDefault();
            (showingLife() ? navigateBar : navigate)(matches[Math.max(0, active)].id);
        } else if (event.key === 'Escape' && !results.hidden) {
            event.preventDefault();
            closeResults();
        }
    });
    results.addEventListener('mousedown', event => event.preventDefault());
    results.addEventListener('click', event => {
        const option = event.target.closest('[data-index]');
        if (option) {
            (showingLife() ? navigateBar : navigate)(matches[option.dataset.index].id);
            if (event.pointerType === 'touch') search.blur();
        }
    });
    window.addEventListener('hashchange', () => { const id = readFragment(); if (!showingLife() && id !== currentId) showPerson(id); });
    const fitButton = document.getElementById('fit');
    fitButton.onclick = () => (showingLife() ? fitLife : fit)();
    document.getElementById('plus').onclick = () => (showingLife() ? zoomLife : zoom)(1.3);
    document.getElementById('minus').onclick = () => (showingLife() ? zoomLife : zoom)(1 / 1.3);
    gestures(svg, zoom, (dx, dy) => { x += dx; y += dy; transform(); });
    svg.removeAttribute('hidden');
    document.querySelector('header').hidden = false;
    if (lifeView) {
        const toggle = document.getElementById('switch-view');
        const lifeSvg = document.getElementById('life-chart');
        const { width } = lifeSvg.viewBox.baseVal;
        let lifeScale = 1, lifeX = 0, lifeY = 0;
        const position = () => { lifeSvg.style.transform = `translate(${lifeX}px,${lifeY}px) scale(${lifeScale})`; };
        const pan = (dx, dy) => { lifeX += dx; lifeY += dy; position(); };
        fitLife = () => {
            closeAnnotation();
            lifeScale = lifeView.clientWidth / width;
            lifeX = lifeY = 0;
            position();
        };
        zoomLife = (factor, cx = lifeView.clientWidth / 2, cy = lifeView.clientHeight / 2) => {
            closeAnnotation();
            const next = Math.max(Math.min(0.01, lifeScale), Math.min(5, lifeScale * factor));
            lifeX = cx - (cx - lifeX) * next / lifeScale;
            lifeY = cy - (cy - lifeY) * next / lifeScale;
            lifeScale = next;
            position();
        };
        lifeView.classList.add('interactive');
        gestures(lifeView, zoomLife, pan);
        navigateBar = id => {
            const bar = bars.get(id);
            closeAnnotation();
            currentBar = id;
            closeResults();
            bar.focus({ preventScroll: true });
            const rect = bar.getBoundingClientRect();
            const view = lifeView.getBoundingClientRect();
            pan(0, view.top + 12 - rect.top);
            showAnnotation(id, bar, bars, navigateBar, true);
        };
        for (const target of targets.children) {
            target.setAttribute('role', 'button');
            target.setAttribute('tabindex', '0');
        }
        targets.setAttribute('visibility', 'visible');
        function open(event) {
            const id = event.target.getAttribute('data-xref');
            if (!id) return;
            if (event.target.hasAttribute('data-bar') || event.target.hasAttribute('data-row')) navigateBar(id);
            else showAnnotation(id, event.target, bars, navigateBar, true);
        }
        targets.addEventListener('click', open);
        targets.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (!event.repeat) open(event);
        });
        lifeView.hidden = true;
        let tipWasHidden, openedLife = false;
        toggle.onclick = () => {
            const showLife = lifeView.hidden;
            closeAnnotation();
            if (showLife) tipWasHidden = tip.hidden;
            tip.hidden = showLife || tipWasHidden;
            svg.toggleAttribute('hidden', showLife);
            lifeView.hidden = !showLife;
            if (showLife && !openedLife) {
                fitLife();
                openedLife = true;
            }
            toggle.textContent = showLife ? '🌳' : '📊';
            const label = showLife ? 'Древо' : 'График';
            toggle.setAttribute('aria-label', label);
            toggle.title = label;
            fitButton.textContent = showLife ? '↔' : '⤢';
            fitButton.title = showLife ? 'Вместить по ширине' : 'Вместить';
            fitButton.setAttribute('aria-label', fitButton.title);
            if (!showLife && readFragment() !== currentId) showPerson(readFragment());
            else closeResults();
        };
    }
    showPerson(readFragment());
} catch (error) { status.textContent = 'Не удалось открыть дерево: ' + error.message; }
