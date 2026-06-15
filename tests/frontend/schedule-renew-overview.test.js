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

  test('rail aggregates same identity and tianti module batches', () => {
    const schedule = window.MiniwebViews.schedule;
    const grouped = schedule.aggregateScheduleRailBatches([
      {
        id: 1,
        send_as_id: 101,
        preset_key: 'tianti_climb_elder',
        label: '登天阶·长老',
        status: 'completed',
        anchor_at: 1000,
        anchor_text: '06-15 08:00',
        updated_at: 1100,
        counts: { scheduled: 2 },
        hidden_item_count: 1,
        items: [{ command: '.登天阶', schedule_at: 1200, status: 'scheduled' }],
        options: { state_contract: { module_key: 'tianti_climb' } },
      },
      {
        id: 2,
        send_as_id: 101,
        preset_key: 'tianti_climb',
        label: '登天阶',
        status: 'completed',
        anchor_at: 900,
        anchor_text: '06-15 07:00',
        updated_at: 1200,
        counts: { scheduled: 3 },
        hidden_item_count: 2,
        items: [{ command: '.登天阶', schedule_at: 1000, status: 'scheduled' }],
        options: { state_contract: { module_key: 'tianti_climb' } },
      },
      {
        id: 3,
        send_as_id: 202,
        preset_key: 'tianti_climb_elder',
        label: '登天阶·长老',
        status: 'completed',
        counts: { scheduled: 1 },
        items: [{ command: '.登天阶', schedule_at: 1300, status: 'scheduled' }],
      },
    ]);

    expect(grouped).toHaveLength(2);
    const wise = grouped.find((item) => Number(item.send_as_id) === 101);
    expect(wise.__batchCount).toBe(2);
    expect(wise.__batchIds).toEqual([1, 2]);
    expect(wise.__groupModuleKey).toBe('tianti_climb');
    expect(wise.counts.scheduled).toBe(5);
    expect(wise.hidden_item_count).toBe(3);
    expect(wise.anchor_text).toBe('06-15 07:00');
    expect(wise.items.map((item) => item.schedule_at)).toEqual([1000, 1200]);
  });

  test('rail filters by selected identity and cards do not open schedule manager', () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [
      { send_as_id: 101, label: 'Wise', enabled: true },
      { send_as_id: 202, label: 'Alt', enabled: true },
    ];
    window.MiniwebState.state.activeIdentityId = 101;
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    const batches = [
      {
        id: 1,
        send_as_id: 101,
        preset_key: 'tianti_climb_elder',
        label: '登天阶·长老',
        status: 'completed',
        anchor_at: 1000,
        anchor_text: '06-15 08:00',
        counts: { scheduled: 2 },
        items: [{ command: '.登天阶', schedule_at: 1200, status: 'scheduled' }],
        options: { renew_profile_id: 7, state_contract: { module_key: 'tianti_climb' } },
      },
      {
        id: 2,
        send_as_id: 101,
        preset_key: 'tianti_climb',
        label: '登天阶',
        status: 'completed',
        anchor_at: 900,
        anchor_text: '06-15 07:00',
        counts: { scheduled: 1 },
        items: [{ command: '.登天阶', schedule_at: 1000, status: 'scheduled' }],
        options: { state_contract: { module_key: 'tianti_climb' } },
      },
      {
        id: 3,
        send_as_id: 202,
        preset_key: 'checkin',
        label: '点卯',
        status: 'completed',
        anchor_at: 1100,
        counts: { scheduled: 1 },
        items: [{ command: '.点卯', schedule_at: 1300, status: 'scheduled' }],
      },
    ];

    const visibleWise = schedule.scheduleVisibleRailBatches({ state: window.MiniwebState.state }, batches);
    expect(visibleWise).toHaveLength(1);
    expect(visibleWise[0].send_as_id).toBe(101);
    expect(visibleWise[0].__batchCount).toBe(2);

    window.MiniwebState.state.scheduleBatches = batches;
    const scheduleRail = document.createElement('section');
    document.body.appendChild(scheduleRail);
    schedule.renderScheduleRail({
      state: window.MiniwebState.state,
      scheduleRail,
      showError: jest.fn(),
    });

    expect(scheduleRail.querySelectorAll('.schedule-rail-row')).toHaveLength(1);
    expect(scheduleRail.textContent).toContain('登天阶');
    expect(scheduleRail.textContent).toContain('合并 2 批');
    expect(scheduleRail.textContent).not.toContain('点卯');
    expect(scheduleRail.textContent).not.toContain('上海时间');
    expect(scheduleRail.querySelector('.schedule-rail-row-main').hasAttribute('data-schedule-open')).toBe(false);
    expect(scheduleRail.querySelector('.schedule-rail-row-main').hasAttribute('data-schedule-preview-toggle')).toBe(true);
    expect(scheduleRail.querySelectorAll('[data-schedule-open]')).toHaveLength(1);

    window.MiniwebState.state.scheduleSelectedSendAsIds = [202];
    const visibleAlt = schedule.scheduleVisibleRailBatches({ state: window.MiniwebState.state }, batches);
    expect(visibleAlt).toHaveLength(1);
    expect(visibleAlt[0].send_as_id).toBe(202);
    expect(visibleAlt[0].label).toBe('日常');
  });

  test('rail groups one identity into daily sect and concubine cards', () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    const grouped = schedule.scheduleVisibleRailBatches({ state: window.MiniwebState.state }, [
      {
        id: 1,
        send_as_id: 101,
        preset_key: 'checkin',
        label: '宗门点卯',
        status: 'completed',
        anchor_at: 1000,
        counts: { scheduled: 1 },
        items: [{ command: '.宗门点卯', schedule_at: 1000, status: 'scheduled' }],
      },
      {
        id: 2,
        send_as_id: 101,
        preset_key: 'tower',
        label: '闯塔',
        status: 'completed',
        anchor_at: 1100,
        counts: { scheduled: 1 },
        items: [{ command: '.闯塔', schedule_at: 1100, status: 'scheduled' }],
      },
      {
        id: 3,
        send_as_id: 101,
        preset_key: 'tianti_climb_elder',
        label: '登天阶·长老',
        status: 'completed',
        anchor_at: 1200,
        counts: { scheduled: 1 },
        items: [{ command: '.登天阶', schedule_at: 1200, status: 'scheduled' }],
        options: { state_contract: { module_key: 'tianti_climb' } },
      },
      {
        id: 4,
        send_as_id: 101,
        preset_key: 'wendao',
        label: '问道',
        status: 'completed',
        anchor_at: 1300,
        counts: { scheduled: 1 },
        items: [{ command: '.问道', schedule_at: 1300, status: 'scheduled' }],
      },
      {
        id: 5,
        send_as_id: 101,
        preset_key: 'concubine_tianji',
        label: '天机代卜',
        status: 'completed',
        anchor_at: 1400,
        counts: { scheduled: 1 },
        items: [{ command: '.天机代卜', schedule_at: 1400, status: 'scheduled' }],
      },
      {
        id: 6,
        send_as_id: 101,
        preset_key: 'concubine_dream',
        label: '入梦寻图',
        status: 'completed',
        anchor_at: 1500,
        counts: { scheduled: 1 },
        items: [{ command: '.入梦寻图', schedule_at: 1500, status: 'scheduled' }],
      },
    ]);

    expect(grouped.map((item) => item.label)).toEqual(['日常', '宗门', '侍妾']);
    const daily = grouped.find((item) => item.label === '日常');
    const sect = grouped.find((item) => item.label === '宗门');
    const concubine = grouped.find((item) => item.label === '侍妾');
    expect(daily.__batchCount).toBe(2);
    expect(daily.__groupPresetKeys.sort()).toEqual(['checkin', 'tower']);
    expect(sect.__batchCount).toBe(2);
    expect(sect.__groupModuleKeys.sort()).toEqual(['tianti_climb', 'wendao']);
    expect(concubine.__batchCount).toBe(2);
    expect(concubine.__groupPresetKeys.sort()).toEqual(['concubine_dream', 'concubine_tianji']);
  });

  test('rail summary exposes renewal coverage counts', () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    window.MiniwebState.state.scheduleRenewAllowedPresets = [
      { preset_key: 'checkin', module_key: 'checkin', interval_sec: 86400 },
      { preset_key: 'tower', module_key: 'tower', interval_sec: 86400 },
      { preset_key: 'wild_training', module_key: 'wild_training', interval_sec: 9000 },
      { preset_key: 'concubine_dream', module_key: 'concubine_dream', interval_sec: 28800 },
    ];
    window.MiniwebState.state.scheduleRenewProfiles = [
      {
        id: 1,
        send_as_id: 101,
        preset_key: 'checkin',
        module_key: 'checkin',
        enabled: true,
        state_contract: { semiauto_ready: true },
      },
      {
        id: 2,
        send_as_id: 101,
        preset_key: 'tower',
        module_key: 'tower',
        enabled: true,
        state_contract: { semiauto_ready: false },
      },
      {
        id: 3,
        send_as_id: 101,
        preset_key: 'wild_training',
        module_key: 'wild_training',
        enabled: false,
        state_contract: { semiauto_ready: true },
      },
    ];
    window.MiniwebState.state.scheduleBatches = [
      {
        id: 1,
        send_as_id: 101,
        preset_key: 'checkin',
        label: '宗门点卯',
        status: 'completed',
        anchor_at: 1000,
        counts: { scheduled: 1 },
        items: [{ command: '.宗门点卯', schedule_at: 1000, status: 'scheduled' }],
      },
    ];

    const scheduleRail = document.createElement('section');
    document.body.appendChild(scheduleRail);
    schedule.renderScheduleRail({
      state: window.MiniwebState.state,
      scheduleRail,
      showError: jest.fn(),
    });

    const summary = scheduleRail.querySelector('.schedule-rail-renew-summary');
    expect(summary).not.toBeNull();
    expect(summary.textContent).toContain('自动中');
    expect(summary.textContent).toContain('待处理');
    expect(summary.textContent).toContain('停用');
    expect(summary.textContent).toContain('可新增');
    expect(summary.textContent).toContain('1自动中');
    expect(summary.textContent).toContain('1待处理');
    expect(summary.textContent).toContain('1停用');
    expect(summary.textContent).toContain('1可新增');
  });

  test('rail card opens plan preview modal and toggles renewal profile', async () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    window.MiniwebState.state.scheduleRenewProfiles = [{
      id: 7,
      send_as_id: 101,
      preset_key: 'tianti_climb_elder',
      module_key: 'tianti_climb',
      label: '登天阶·长老',
      enabled: true,
      renew_days: 1,
      threshold_hours: 24,
      soft_limit: 95,
      covered_until_text: '06-16 08:00',
      state_contract: { module_key: 'tianti_climb', semiauto_ready: true },
      payload: { send_as_id: 101, preset_key: 'tianti_climb_elder', auto_anchor_module: 'tianti_climb' },
    }];
    window.MiniwebState.state.scheduleBatches = [{
      id: 1,
      send_as_id: 101,
      preset_key: 'tianti_climb_elder',
      label: '登天阶·长老',
      status: 'completed',
      anchor_at: 900,
      anchor_text: '06-15 07:00',
      counts: { scheduled: 2 },
      items: [
        { command: '.登天阶', schedule_at: 1000, schedule_text: '06-15 07:10', status: 'scheduled', scheduled_msg_id: 280 },
        { command: '.登天阶', schedule_at: 1200, schedule_text: '06-15 07:30', status: 'scheduled', scheduled_msg_id: 281 },
      ],
      options: { renew_profile_id: 7, state_contract: { module_key: 'tianti_climb' } },
    }];
    window.MiniwebApi.postJson.mockResolvedValue({
      ok: true,
      profiles: [{ ...window.MiniwebState.state.scheduleRenewProfiles[0], enabled: false }],
    });
    window.MiniwebModal.openModal.mockImplementation(({ title, body }) => {
      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog';
      dialog.innerHTML = `
        <div class="modal-head"><h3>${title || ''}</h3></div>
        <div class="modal-body">${body || ''}</div>
      `;
      document.body.appendChild(dialog);
      return dialog;
    });

    const scheduleRail = document.createElement('section');
    document.body.appendChild(scheduleRail);
    schedule.renderScheduleRail({
      state: window.MiniwebState.state,
      scheduleRail,
      showError: jest.fn(),
    });

    expect(scheduleRail.textContent).toContain('自动中');
    const main = scheduleRail.querySelector('.schedule-rail-row-main');
    main.click();

    expect(scheduleRail.querySelector('.schedule-rail-row-main').hasAttribute('aria-expanded')).toBe(false);
    const previewDialog = document.querySelector('.schedule-preview-dialog');
    expect(previewDialog).not.toBeNull();
    expect(previewDialog.textContent).toContain('计划预览');
    expect(previewDialog.textContent).toContain('06-15 07:10');
    expect(scheduleRail.textContent).not.toContain('计划预览');
    expect(window.MiniwebApi.fetchJson).not.toHaveBeenCalledWith('/api/schedule?history=0');

    const toggle = scheduleRail.querySelector('[data-schedule-renew-toggle]');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(window.MiniwebApi.postJson).toHaveBeenCalledWith(
      '/api/schedule/renew/save',
      expect.objectContaining({ id: 7, enabled: false, module_key: 'tianti_climb' })
    );
    expect(scheduleRail.textContent).toContain('已停用');
  });
});
