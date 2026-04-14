const $ = s => document.querySelector(s);
const setStatus = (msg, type) => { const el = $('#status'); el.textContent = msg; el.className = 'status ' + type; };
const setDetails = msg => { $('#details').innerHTML = msg; };

// version
const m = chrome.runtime.getManifest();
$('#ver').textContent = `v${m.version}`;

// ── EXPORT ──
$('#btnExport').addEventListener('click', async () => {
  try {
    $('#btnExport').disabled = true;
    setStatus('Exportuji...', 'info');

    const [syncData, localData] = await Promise.all([
      chrome.storage.sync.get(null),
      chrome.storage.local.get(null)
    ]);

    const backup = {
      _meta: {
        version: m.version,
        date: new Date().toISOString(),
        type: 'unitychat-backup'
      },
      sync: syncData,
      local: localData
    };

    const json = JSON.stringify(backup, null, 2);
    const dataUrl = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(json)));
    const filename = `unitychat-backup-${new Date().toISOString().slice(0, 10)}.json`;

    await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });

    const syncKeys = Object.keys(syncData);
    const localKeys = Object.keys(localData);
    const msgKeys = localKeys.filter(k => k.startsWith('uc_messages_'));
    const size = (json.length / 1024).toFixed(1);

    setStatus('Export hotov!', 'ok');
    setDetails(
      `<code>${size} KB</code> | ` +
      `sync: <code>${syncKeys.join(', ') || '(prazdne)'}</code> | ` +
      `local: <code>${localKeys.length}</code> klicu ` +
      `(${msgKeys.length} message cache${msgKeys.length !== 1 ? 's' : ''}, ` +
      `nicknames: <code>${localData.uc_nicknames ? Object.keys(localData.uc_nicknames).length : 0}</code>, ` +
      `colors: <code>${localData.uc_user_colors ? Object.keys(localData.uc_user_colors).length : 0}</code>)`
    );
  } catch (e) {
    setStatus('Chyba: ' + e.message, 'err');
  } finally {
    $('#btnExport').disabled = false;
  }
});

// ── IMPORT ──
$('#btnImport').addEventListener('click', () => $('#fileInput').click());

$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  try {
    setStatus('Importuji...', 'info');
    const text = await file.text();
    const backup = JSON.parse(text);

    if (!backup._meta || backup._meta.type !== 'unitychat-backup') {
      setStatus('Neplatny soubor — chybi _meta.type unitychat-backup', 'err');
      return;
    }

    const ops = [];
    if (backup.sync && Object.keys(backup.sync).length > 0) {
      ops.push(chrome.storage.sync.set(backup.sync));
    }
    if (backup.local && Object.keys(backup.local).length > 0) {
      ops.push(chrome.storage.local.set(backup.local));
    }
    await Promise.all(ops);

    const syncN = backup.sync ? Object.keys(backup.sync).length : 0;
    const localN = backup.local ? Object.keys(backup.local).length : 0;

    setStatus('Import hotov! Reload extension pro aplikovani.', 'ok');
    setDetails(
      `Ze souboru z <code>${backup._meta.date?.slice(0, 10) || '?'}</code> ` +
      `(v${backup._meta.version || '?'}) | ` +
      `sync: <code>${syncN}</code> klicu, local: <code>${localN}</code> klicu`
    );
  } catch (e) {
    setStatus('Chyba: ' + e.message, 'err');
  }
});
