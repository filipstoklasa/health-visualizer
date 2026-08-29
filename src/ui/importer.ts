import type { Aggregate, IngestMessage } from '../types.ts';
import { idbPut } from '../storage.ts';
import { esc } from '../format.ts';
import { $ } from '../dom.ts';

/** Parse an export.zip in a worker, store the aggregate, then hand it over. */
export function importZip(file: File, onDone: (d: Aggregate) => void): void {
  $('#import').hidden = false;
  $('#bar').hidden = false;
  $('#progress').textContent = 'Reading ' + file.name;

  const worker = new Worker(new URL('../ingest.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ file });

  worker.onmessage = async ({ data }: MessageEvent<IngestMessage>) => {
    if ('progress' in data) {
      $('#barFill').style.width = Math.round(data.progress * 100) + '%';
      $('#progress').textContent = `${data.label}… ${Math.round(data.progress * 100)}%`;
      return;
    }
    worker.terminate();
    if ('error' in data) {
      $('#progress').innerHTML = `<span class="err">${esc(data.error)}</span>`;
      $('#bar').hidden = true;
      return;
    }
    $('#progress').textContent = 'Saving…';
    try {
      await idbPut('latest', { data: data.result, importedAt: new Date().toISOString() });
    } catch (e) {
      $('#progress').innerHTML = `<span class="err">Parsed fine, but could not save it (${esc((e as Error).message)}).`
        + ' Showing it anyway — you will have to re-import next time.</span>';
    }
    $('#import').hidden = true;
    onDone(data.result);
  };

  worker.onerror = e => {
    $('#progress').innerHTML = `<span class="err">The importer could not start (${esc(e.message)}).</span>`;
  };
}

/** File picker, drag-and-drop. */
export function wireImport(onDone: (d: Aggregate) => void): void {
  const start = (f: File) => importZip(f, onDone);
  const input = $<HTMLInputElement>('#file');

  input.onchange = e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) start(f);
  };
  const openPicker = () => input.click();
  $('#pick').onclick = openPicker;
  $('#pick2').onclick = openPicker;

  window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', e => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const f = [...(e.dataTransfer?.files ?? [])].find(x => x.name.endsWith('.zip'));
    if (f) start(f);
    else $('#progress').innerHTML = '<span class="err">That is not a .zip file.</span>';
  });
}
