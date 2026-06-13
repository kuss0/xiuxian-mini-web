describe('Official schedule renewal overview', () => {
  function buildDialog() {
    const dialog = document.createElement('div');
    dialog.innerHTML = `
      <form id="scheduleForm">
        <select id="scheduleSendAsSelect" name="send_as_ids" multiple>
          <option value="101" selected>Wise</option>
        </select>
        <span id="scheduleSendAsCount"></span>
        <select name="preset_key">
          <option value="custom">自定义</option>
        </select>
        <select id="scheduleStateModuleSelect" name="auto_anchor_module">
          <option value="">跟随预设 / 不使用</option>
          <option value="checkin">点卯</option>
        </select>
        <input name="anchor_at_text" />
        <input name="auto_anchor" type="checkbox" />
        <input name="schedule_use_module_defaults" type="checkbox" />
      </form>
      <p id="scheduleStatus" hidden></p>
      <div id="schedulePreview" hidden></div>
      <div id="scheduleBatchList"></div>
      <strong id="scheduleIdentitySummary"></strong>
      <small id="scheduleIdentityScope"></small>

      <form id="scheduleRenewForm">
        <input type="hidden" name="id" value="42" />
        <select id="scheduleRenewSendAsSelect" name="send_as_id">
          <option value="101">Wise</option>
        </select>
        <select id="scheduleRenewPresetSelect" name="preset_key">
          <option value="wild_training">野外历练</option>
          <option value="checkin">点卯</option>
        </select>
        <select id="scheduleRenewModuleSelect" name="module_key">
          <option value="wild_training">野外历练</option>
          <option value="checkin">点卯</option>
        </select>
        <input name="renew_days" value="1" />
        <input name="threshold_hours" value="24" />
        <input name="soft_limit" value="95" />
        <input name="enabled" type="checkbox" checked />
      </form>
      <div id="scheduleRenewWorkerStatus"></div>
      <div id="scheduleRenewOverview"></div>
      <p id="scheduleRenewStatus" hidden></p>
      <div id="scheduleRenewPreview" hidden></div>
      <div id="scheduleRenewProfileList"></div>
    `;
    document.body.appendChild(dialog);
    return dialog;
  }

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '';
    window.MiniwebState.state = {
      identities: [{ send_as_id: 101, label: 'Wise', enabled: true }],
      accounts: [],
      scheduleSelectedSendAsIds: [101],
    };
    window.MiniwebApi.fetchJson.mockReset();
    window.MiniwebApi.postJson.mockReset();
    window.MiniwebModal = { openModal: jest.fn() };
    require('../../web/static/views/schedule.js');
  });

  test('clicking addable renewal preset only fills the draft form', async () => {
    window.MiniwebApi.fetchJson.mockImplementation((url) => {
      if (url === '/api/schedule/renew') {
        return Promise.resolve({
          ok: true,
          profiles: [],
          allowed_presets: [
            { preset_key: 'checkin', module_key: 'checkin', interval_sec: 86400 },
          ],
          worker: { running: true, last_run_text: '06-14 03:37', last_result: { ok: true, processed: 0 } },
        });
      }
      return Promise.resolve({ ok: true, batches: [] });
    });

    const dialog = buildDialog();
    const schedule = window.MiniwebViews.schedule;
    schedule.bindScheduleModal(
      { state: window.MiniwebState.state },
      dialog,
      [{ key: 'checkin', label: '点卯', description: '每日点卯', fields: [], module_key: 'checkin' }],
      [],
      [],
      {
        modules: [{ key: 'checkin', label: '点卯', suggestion: {} }],
        by_identity: [{
          send_as_id: 101,
          items: [{ module_key: 'checkin', semiauto_ready: true }],
        }],
      }
    );

    await Promise.resolve();
    await Promise.resolve();

    const applyButton = dialog.querySelector('[data-schedule-renew-overview-action="apply"][data-schedule-renew-preset="checkin"]');
    expect(applyButton).not.toBeNull();

    dialog.querySelector('[name="id"]').value = '42';
    applyButton.click();

    expect(dialog.querySelector('#scheduleRenewSendAsSelect').value).toBe('101');
    expect(dialog.querySelector('#scheduleRenewPresetSelect').value).toBe('checkin');
    expect(dialog.querySelector('#scheduleRenewModuleSelect').value).toBe('checkin');
    expect(dialog.querySelector('[name="id"]').value).toBe('');
    expect(dialog.querySelector('#scheduleRenewStatus').textContent).toBe('已套用可新增续期预设');
    expect(window.MiniwebApi.postJson).not.toHaveBeenCalled();
  });
});
