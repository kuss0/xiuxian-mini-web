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
          <option value="checkin">点卯</option>
        </select>
        <div id="schedulePlanWorkbench"></div>
        <div id="scheduleCommandGroupEditor">
          <label data-show-when="command">
            <textarea name="command"></textarea>
          </label>
          <label data-show-when="interval_sec">
            <input name="interval_sec" value="3600" />
          </label>
          <label data-show-when="count">
            <input name="count" value="3" />
          </label>
          <label data-show-when="command_gap_sec">
            <input name="command_gap_sec" value="180" />
          </label>
        </div>
        <select id="scheduleStateModuleSelect" name="auto_anchor_module">
          <option value="">跟随预设 / 不使用</option>
          <option value="checkin">点卯</option>
        </select>
        <div id="scheduleQueryCommandPanel">
          <small id="scheduleQueryCommandMeta"></small>
          <select id="scheduleQueryCommandSelect"></select>
          <button type="button" id="scheduleCopyQueryCommandButton" data-schedule-query-copy>复制查询</button>
        </div>
        <input name="anchor_at_text" />
        <input name="auto_anchor" type="checkbox" />
        <input name="schedule_use_module_defaults" type="checkbox" />
        <div id="scheduleStateHint" hidden></div>
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

  test('checking addable renewal preset saves the profile directly', async () => {
    const now = Date.now() / 1000;
    const freshContract = {
      semiauto_ready: true,
      updated_at: now,
      next_at: now + 3600,
      source_message_id: 'raw-checkin',
      warnings: [],
      evidence: { latest_family: 'checkin', latest_reason: 'state_updated' },
      module_contract: { readiness: 'sample_complete', reply_families: ['checkin'] },
    };
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
    window.MiniwebApi.postJson.mockResolvedValue({
      ok: true,
      profile: {
        id: 9,
        send_as_id: 101,
        preset_key: 'checkin',
        module_key: 'checkin',
        label: '点卯',
        enabled: true,
        state_contract: freshContract,
      },
      profiles: [{
        id: 9,
        send_as_id: 101,
        preset_key: 'checkin',
        module_key: 'checkin',
        label: '点卯',
        enabled: true,
        state_contract: freshContract,
      }],
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
          items: [{ module_key: 'checkin', ...freshContract }],
        }],
      }
    );

    await Promise.resolve();
    await Promise.resolve();

    const checkbox = dialog.querySelector('[data-schedule-renew-overview-action="enable"][data-schedule-renew-preset="checkin"]');
    expect(checkbox).not.toBeNull();

    dialog.querySelector('[name="id"]').value = '42';
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog.querySelector('#scheduleRenewSendAsSelect').value).toBe('101');
    expect(dialog.querySelector('#scheduleRenewPresetSelect').value).toBe('checkin');
    expect(dialog.querySelector('#scheduleRenewModuleSelect').value).toBe('checkin');
    expect(dialog.querySelector('[name="id"]').value).toBe('9');
    expect(dialog.querySelector('#scheduleRenewStatus').textContent).toBe('已开启 点卯 自动续期');
    expect(window.MiniwebApi.postJson).toHaveBeenCalledWith(
      '/api/schedule/renew/save',
      expect.objectContaining({
        send_as_id: 101,
        preset_key: 'checkin',
        module_key: 'checkin',
        enabled: true,
      })
    );
  });

  test('schedule workbench preset shortcut applies state defaults', () => {
    const schedule = window.MiniwebViews.schedule;
    const dialog = buildDialog();
    schedule.bindScheduleModal(
      { state: window.MiniwebState.state },
      dialog,
      [
        {
          key: 'custom',
          label: '自定义',
          description: '自定义多命令',
          fields: ['command', 'interval_sec', 'count', 'command_gap_sec'],
          module_key: '',
          ui: { category: 'custom', shape: 'custom', automation: 'manual', tags: ['联动'] },
        },
        {
          key: 'checkin',
          label: '点卯',
          description: '每日点卯',
          fields: ['horizon_days'],
          module_key: 'checkin',
          ui: { category: 'daily', shape: 'daily', automation: 'renewable', tags: ['常用'] },
        },
      ],
      [],
      [],
      {
        modules: [{ key: 'checkin', label: '点卯', suggestion: {} }],
        by_identity: [{
          send_as_id: 101,
          items: [{
            module_key: 'checkin',
            semiauto_ready: true,
            summary: { text: '今晚可排' },
            suggestion: {
              preset_key: 'checkin',
              automation_level: 'semiauto',
              payload_defaults: { preset_key: 'checkin', command: '.宗门点卯', interval_sec: 86400 },
            },
            warnings: [],
          }],
        }],
      }
    );

    const shortcut = dialog.querySelector('[data-schedule-plan-preset="checkin"]');
    expect(shortcut).not.toBeNull();
    expect(dialog.querySelector('[data-schedule-plan-panel="presets"]').hidden).toBe(false);
    expect(dialog.querySelector('[data-schedule-plan-panel="state"]').hidden).toBe(true);
    expect(dialog.querySelector('[data-schedule-plan-panel="custom"]').hidden).toBe(true);
    dialog.querySelector('[data-schedule-plan-mode="state"]').click();
    expect(dialog.querySelector('[data-schedule-plan-panel="presets"]').hidden).toBe(true);
    expect(dialog.querySelector('[data-schedule-plan-panel="state"]').hidden).toBe(false);
    expect(dialog.querySelector('[data-schedule-plan-panel="custom"]').hidden).toBe(true);
    shortcut.click();

    expect(dialog.querySelector('[name="preset_key"]').value).toBe('checkin');
    expect(dialog.querySelector('#scheduleStateModuleSelect').value).toBe('checkin');
    expect(dialog.querySelector('[name="auto_anchor"]').checked).toBe(true);
    expect(dialog.querySelector('[name="schedule_use_module_defaults"]').checked).toBe(true);
    expect(dialog.querySelector('#scheduleStatus').textContent).toBe('已套用方案: 点卯');
    expect(shortcut.getAttribute('aria-pressed')).toBe('true');
  });

  test('schedule query helper copies the selected module status command', async () => {
    const schedule = window.MiniwebViews.schedule;
    const copyCommandToClipboard = jest.fn().mockResolvedValue();
    window.MiniwebApi.fetchJson.mockResolvedValue({
      ok: true,
      profiles: [],
      allowed_presets: [],
      worker: null,
    });
    const dialog = buildDialog();
    dialog.querySelector('[name="preset_key"]').insertAdjacentHTML('beforeend', '<option value="yuanying">元婴</option>');
    dialog.querySelector('#scheduleStateModuleSelect').insertAdjacentHTML('beforeend', '<option value="yuanying">元婴</option>');
    dialog.querySelector('[name="preset_key"]').value = 'yuanying';

    schedule.bindScheduleModal(
      { state: window.MiniwebState.state, copyCommandToClipboard },
      dialog,
      [{
        key: 'yuanying',
        label: '元婴',
        description: '元婴出窍',
        fields: ['horizon_days'],
        module_key: 'yuanying',
      }],
      [],
      [],
      {
        modules: [{
          key: 'yuanying',
          label: '元婴',
          suggestion: { trigger_command: '.元婴状态' },
        }],
        by_identity: [{
          send_as_id: 101,
          items: [{
            module_key: 'yuanying',
            label: '元婴',
            semiauto_ready: false,
            summary: { text: '归来倒计时 1小时' },
            suggestion: {
              trigger_command: '.元婴状态',
              payload_defaults: { trigger_command: '.元婴状态' },
            },
            warnings: [],
          }],
        }],
      }
    );

    const select = dialog.querySelector('#scheduleQueryCommandSelect');
    const button = dialog.querySelector('[data-schedule-query-copy]');
    expect(select.value).toBe('.元婴状态');
    expect(dialog.querySelector('#scheduleQueryCommandMeta').textContent).toContain('元婴');

    button.click();
    await Promise.resolve();

    expect(copyCommandToClipboard).toHaveBeenCalledWith('.元婴状态', button);
    expect(dialog.querySelector('#scheduleStatus').textContent).toBe('已复制查询指令: .元婴状态');
    expect(window.MiniwebApi.postJson).not.toHaveBeenCalledWith('/api/skills/send', expect.anything());
  });

  test('workbench exposes module cards as scheduling entry points', () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.activeIdentityId = 101;
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    window.MiniwebState.state.scheduleBatches = [];
    window.MiniwebState.state.schedulePresets = [
      {
        key: 'checkin',
        label: '点卯',
        description: '每日点卯',
        fields: ['horizon_days'],
        module_key: 'checkin',
        ui: { category: 'daily', shape: 'daily', automation: 'renewable', tags: ['常用'] },
      },
    ];
    window.MiniwebState.state.scheduleModules = {
      modules: [{ key: 'checkin', label: '点卯', suggestion: {} }],
      by_identity: [{
        send_as_id: 101,
        items: [{
          module_key: 'checkin',
          label: '点卯',
          semiauto_ready: true,
          one_click_ready: true,
          summary: { text: '今晚可排' },
          suggestion: { preset_key: 'checkin', automation_level: 'semiauto' },
          warnings: [],
        }],
      }],
    };

    const panel = document.createElement('section');
    panel.className = 'schedule-workbench';
    const scheduleRail = document.createElement('div');
    panel.appendChild(scheduleRail);
    document.body.appendChild(panel);

    schedule.renderScheduleRail({
      state: window.MiniwebState.state,
      scheduleRail,
      showError: jest.fn(),
    });

    const card = scheduleRail.querySelector('[data-schedule-module-open][data-schedule-module="checkin"]');
    expect(card).not.toBeNull();
    expect(card.dataset.schedulePreset).toBe('checkin');
    expect(card.dataset.scheduleSendAs).toBe('101');
    expect(scheduleRail.textContent).toContain('模块排班');
    expect(scheduleRail.textContent).toContain('点卯');
  });

  test('module cards remain clickable while schedule rail is loading', async () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.activeIdentityId = 101;
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    window.MiniwebState.state.scheduleLoading = true;
    window.MiniwebState.state.scheduleBatches = [];
    window.MiniwebState.state.scheduleBootstrapLoadedAt = Date.now();
    window.MiniwebState.state.schedulePresets = [{
      key: 'checkin',
      label: '点卯',
      description: '每日点卯',
      fields: ['horizon_days'],
      module_key: 'checkin',
      ui: { category: 'daily', shape: 'daily', automation: 'renewable', tags: ['常用'] },
    }];
    window.MiniwebState.state.scheduleModules = {
      modules: [{ key: 'checkin', label: '点卯', suggestion: {} }],
      by_identity: [{
        send_as_id: 101,
        items: [{
          module_key: 'checkin',
          label: '点卯',
          semiauto_ready: true,
          one_click_ready: true,
          summary: { text: '今晚可排' },
          suggestion: { preset_key: 'checkin', automation_level: 'semiauto' },
          warnings: [],
        }],
      }],
    };
    window.MiniwebModal.openModal.mockImplementation(({ title, body, footer }) => {
      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog';
      dialog.innerHTML = `
        <div class="modal-head"><h3>${title || ''}</h3></div>
        <div class="modal-body">${body || ''}</div>
        <div class="modal-foot">${footer || ''}</div>
      `;
      document.body.appendChild(dialog);
      return dialog;
    });

    const panel = document.createElement('section');
    panel.className = 'schedule-workbench';
    const scheduleRail = document.createElement('div');
    panel.appendChild(scheduleRail);
    document.body.appendChild(panel);

    schedule.renderScheduleRail({
      state: window.MiniwebState.state,
      scheduleRail,
      showError: jest.fn(),
    });

    scheduleRail.querySelector('[data-schedule-module-open][data-schedule-module="checkin"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.schedule-quick-dialog #scheduleQuickForm')).not.toBeNull();
  });

  test('module card click opens the quick scheduling dialog', async () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.activeIdentityId = 101;
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    window.MiniwebState.state.scheduleBatches = [];
    const presets = [
      {
        key: 'custom',
        label: '自定义',
        description: '自定义多命令',
        fields: ['command', 'interval_sec', 'count', 'command_gap_sec'],
        module_key: '',
        ui: { category: 'custom', shape: 'custom', automation: 'manual', tags: ['联动'] },
      },
      {
        key: 'checkin',
        label: '点卯',
        description: '每日点卯',
        fields: ['horizon_days'],
        module_key: 'checkin',
        ui: { category: 'daily', shape: 'daily', automation: 'renewable', tags: ['常用'] },
      },
    ];
    const modulesPayload = {
      modules: [{ key: 'checkin', label: '点卯', suggestion: {} }],
      by_identity: [{
        send_as_id: 101,
        items: [{
          module_key: 'checkin',
          label: '点卯',
          semiauto_ready: true,
          summary: { text: '今晚可排' },
          suggestion: {
            preset_key: 'checkin',
            automation_level: 'semiauto',
            payload_defaults: {
              preset_key: 'checkin',
              command: '.宗门点卯',
              interval_sec: 86400,
              horizon_days: 3,
            },
          },
          warnings: [],
        }],
      }],
    };
    window.MiniwebState.state.schedulePresets = presets;
    window.MiniwebState.state.scheduleModules = modulesPayload;
    window.MiniwebApi.fetchJson.mockImplementation((url) => {
      if (String(url).startsWith('/api/schedule/bootstrap')) {
        return Promise.resolve({ ok: true, presets, templates: [], ...modulesPayload });
      }
      return Promise.resolve({ ok: true, batches: [] });
    });
    window.MiniwebApi.postJson.mockResolvedValue({
      ok: true,
      preset_label: '点卯',
      first_due_text: '今晚',
      anchor_text: '状态机时间',
      items: [{ command: '.宗门点卯', schedule_text: '今晚' }],
    });
    window.MiniwebModal.openModal.mockImplementation(({ title, body, footer }) => {
      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog';
      dialog.innerHTML = `
        <div class="modal-head"><h3>${title || ''}</h3></div>
        <div class="modal-body">${body || ''}</div>
        <div class="modal-foot">${footer || ''}</div>
      `;
      document.body.appendChild(dialog);
      return dialog;
    });

    const panel = document.createElement('section');
    panel.className = 'schedule-workbench';
    const scheduleRail = document.createElement('div');
    panel.appendChild(scheduleRail);
    document.body.appendChild(panel);

    schedule.renderScheduleRail({
      state: window.MiniwebState.state,
      scheduleRail,
      showError: jest.fn(),
    });

    scheduleRail.querySelector('[data-schedule-module-open][data-schedule-module="checkin"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dialog = document.querySelector('.schedule-quick-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('#scheduleQuickForm')).not.toBeNull();
    expect(dialog.querySelector('#scheduleForm')).toBeNull();
    expect(dialog.querySelector('[data-schedule-quick-create]')).not.toBeNull();
    expect(dialog.textContent).toContain('排几天');
    expect(dialog.textContent).toContain('状态机时间');

    dialog.querySelector('[data-schedule-quick-preview]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.MiniwebApi.postJson).toHaveBeenCalledWith(
      '/api/schedule/preview',
      expect.objectContaining({
        send_as_id: 101,
        preset_key: 'checkin',
        auto_anchor: true,
        auto_anchor_module: 'checkin',
        schedule_use_module_defaults: true,
        schedule_semiauto: true,
        command: '.宗门点卯',
        interval_sec: 86400,
      })
    );
    expect(dialog.querySelector('#scheduleQuickPreview').hidden).toBe(false);
  });

  test('manual-confirm module quick dialog does not expose create action', async () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.activeIdentityId = 101;
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    const presets = [{
      key: 'deep_retreat',
      label: '深度闭关',
      description: '阶段型闭关',
      fields: ['horizon_days'],
      module_key: 'deep_retreat',
      ui: { category: 'phase', shape: 'state', automation: 'manual_followup', tags: ['阶段'] },
    }];
    const modulesPayload = {
      modules: [{ key: 'deep_retreat', label: '深度闭关', suggestion: {} }],
      by_identity: [{
        send_as_id: 101,
        items: [{
          module_key: 'deep_retreat',
          label: '深度闭关',
          semiauto_ready: false,
          one_click_ready: true,
          summary: { text: '进行中' },
          suggestion: {
            preset_key: 'deep_retreat',
            automation_level: 'manual',
            payload_defaults: { preset_key: 'deep_retreat', command: '.深度闭关', interval_sec: 28800 },
          },
          warnings: [{ code: 'phaseful', message: '阶段型状态需要人工确认', severity: 'warn' }],
        }],
      }],
    };
    window.MiniwebState.state.schedulePresets = presets;
    window.MiniwebState.state.scheduleModules = modulesPayload;
    window.MiniwebApi.fetchJson.mockImplementation((url) => {
      if (String(url).startsWith('/api/schedule/bootstrap')) {
        return Promise.resolve({ ok: true, presets, templates: [], ...modulesPayload });
      }
      return Promise.resolve({ ok: true, batches: [] });
    });
    window.MiniwebApi.postJson.mockResolvedValue({
      ok: true,
      preset_label: '深度闭关',
      first_due_text: '稍后',
      anchor_text: '状态机时间',
      items: [{ command: '.深度闭关', schedule_text: '稍后' }],
    });
    window.MiniwebModal.openModal.mockImplementation(({ title, body, footer }) => {
      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog';
      dialog.innerHTML = `
        <div class="modal-head"><h3>${title || ''}</h3></div>
        <div class="modal-body">${body || ''}</div>
        <div class="modal-foot">${footer || ''}</div>
      `;
      document.body.appendChild(dialog);
      return dialog;
    });

    await schedule.openScheduleModuleQuickModal(
      { state: window.MiniwebState.state },
      { sendAsId: 101, moduleKey: 'deep_retreat', presetKey: 'deep_retreat' }
    );

    const dialog = document.querySelector('.schedule-quick-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('[data-schedule-quick-preview]')).not.toBeNull();
    expect(dialog.querySelector('[data-schedule-quick-create]')).toBeNull();
    expect(dialog.querySelector('[data-schedule-quick-advanced]')).not.toBeNull();
    expect(dialog.textContent).toContain('需确认');

    dialog.querySelector('[data-schedule-quick-preview]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.MiniwebApi.postJson).toHaveBeenCalledWith(
      '/api/schedule/preview',
      expect.objectContaining({
        send_as_id: 101,
        preset_key: 'deep_retreat',
        auto_anchor: true,
        auto_anchor_module: 'deep_retreat',
        schedule_use_module_defaults: true,
        schedule_semiauto: false,
      })
    );
  });

  test('opening schedule modal from module preselects that module', async () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.activeIdentityId = 101;
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    const presets = [
      {
        key: 'custom',
        label: '自定义',
        description: '自定义多命令',
        fields: ['command', 'interval_sec', 'count', 'command_gap_sec'],
        module_key: '',
        ui: { category: 'custom', shape: 'custom', automation: 'manual', tags: ['联动'] },
      },
      {
        key: 'checkin',
        label: '点卯',
        description: '每日点卯',
        fields: ['horizon_days'],
        module_key: 'checkin',
        ui: { category: 'daily', shape: 'daily', automation: 'renewable', tags: ['常用'] },
      },
    ];
    const modulesPayload = {
      modules: [{ key: 'checkin', label: '点卯', suggestion: {} }],
      by_identity: [{
        send_as_id: 101,
        items: [{
          module_key: 'checkin',
          label: '点卯',
          semiauto_ready: true,
          summary: { text: '今晚可排' },
          suggestion: {
            preset_key: 'checkin',
            automation_level: 'semiauto',
            payload_defaults: { preset_key: 'checkin', command: '.宗门点卯', interval_sec: 86400 },
          },
          warnings: [],
        }],
      }],
    };
    window.MiniwebApi.fetchJson.mockImplementation((url) => {
      if (String(url).startsWith('/api/schedule/bootstrap')) {
        return Promise.resolve({ ok: true, presets, templates: [], ...modulesPayload });
      }
      if (url === '/api/schedule/renew') {
        return Promise.resolve({ ok: true, profiles: [], allowed_presets: [], worker: null });
      }
      return Promise.resolve({ ok: true, batches: [] });
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

    await schedule.openScheduleModal(
      { state: window.MiniwebState.state },
      { sendAsId: 101, moduleKey: 'checkin', mode: 'state' }
    );

    const dialog = document.querySelector('.schedule-modal-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('[name="preset_key"]').value).toBe('checkin');
    expect(dialog.querySelector('#scheduleStateModuleSelect').value).toBe('checkin');
    expect(dialog.querySelector('[name="auto_anchor"]').checked).toBe(true);
    expect(dialog.querySelector('[data-schedule-plan-panel="state"]').hidden).toBe(false);
    expect(dialog.querySelector('#scheduleStatus').textContent).toBe('已套用方案: 点卯');
  });

  test('opening full schedule modal from manual module keeps confirmation warning', async () => {
    const schedule = window.MiniwebViews.schedule;
    window.MiniwebState.state.identities = [{ send_as_id: 101, label: 'Wise', enabled: true }];
    window.MiniwebState.state.activeIdentityId = 101;
    window.MiniwebState.state.scheduleSelectedSendAsIds = [101];
    const presets = [
      {
        key: 'custom',
        label: '自定义',
        description: '自定义多命令',
        fields: ['command', 'interval_sec', 'count', 'command_gap_sec'],
        module_key: '',
        ui: { category: 'custom', shape: 'custom', automation: 'manual', tags: ['联动'] },
      },
      {
        key: 'deep_retreat',
        label: '深度闭关',
        description: '阶段型闭关',
        fields: ['horizon_days'],
        module_key: 'deep_retreat',
        ui: { category: 'phase', shape: 'state', automation: 'manual_followup', tags: ['阶段'] },
      },
    ];
    const modulesPayload = {
      modules: [{ key: 'deep_retreat', label: '深度闭关', suggestion: {} }],
      by_identity: [{
        send_as_id: 101,
        items: [{
          module_key: 'deep_retreat',
          label: '深度闭关',
          semiauto_ready: false,
          one_click_ready: true,
          summary: { text: '进行中' },
          suggestion: {
            preset_key: 'deep_retreat',
            automation_level: 'manual',
            payload_defaults: { preset_key: 'deep_retreat', command: '.深度闭关', interval_sec: 28800 },
          },
          warnings: [{ code: 'phaseful', message: '阶段型状态需要人工确认', severity: 'warn' }],
        }],
      }],
    };
    window.MiniwebApi.fetchJson.mockImplementation((url) => {
      if (String(url).startsWith('/api/schedule/bootstrap')) {
        return Promise.resolve({ ok: true, presets, templates: [], ...modulesPayload });
      }
      if (url === '/api/schedule/renew') {
        return Promise.resolve({ ok: true, profiles: [], allowed_presets: [], worker: null });
      }
      return Promise.resolve({ ok: true, batches: [] });
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

    await schedule.openScheduleModal(
      { state: window.MiniwebState.state },
      { sendAsId: 101, moduleKey: 'deep_retreat', mode: 'state' }
    );

    const dialog = document.querySelector('.schedule-modal-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('[name="preset_key"]').value).toBe('deep_retreat');
    expect(dialog.querySelector('#scheduleStateModuleSelect').value).toBe('deep_retreat');
    expect(dialog.querySelector('[name="auto_anchor"]').checked).toBe(true);
    expect(dialog.querySelector('#scheduleStatus').className).toContain('warn');
    expect(dialog.querySelector('#scheduleStatus').textContent).toContain('需确认');
    expect(dialog.querySelector('#scheduleStatus').textContent).toContain('阶段型状态需要人工确认');
  });

  test('schedule workbench custom examples fill multi-command group', () => {
    const schedule = window.MiniwebViews.schedule;
    const dialog = buildDialog();
    schedule.bindScheduleModal(
      { state: window.MiniwebState.state },
      dialog,
      [
        {
          key: 'custom',
          label: '自定义',
          description: '自定义多命令',
          fields: ['command', 'interval_sec', 'count', 'command_gap_sec'],
          module_key: '',
          ui: { category: 'custom', shape: 'custom', automation: 'manual', tags: ['联动'] },
        },
      ],
      [],
      [],
      { modules: [], by_identity: [] }
    );

    const example = dialog.querySelector('[data-schedule-custom-example="daily_pair"]');
    expect(example).not.toBeNull();
    expect(dialog.querySelector('[data-schedule-plan-panel="custom"]').hidden).toBe(true);
    dialog.querySelector('[data-schedule-plan-mode="custom"]').click();
    expect(dialog.querySelector('[data-schedule-plan-panel="presets"]').hidden).toBe(true);
    expect(dialog.querySelector('[data-schedule-plan-panel="state"]').hidden).toBe(true);
    expect(dialog.querySelector('[data-schedule-plan-panel="custom"]').hidden).toBe(false);
    example.click();

    expect(dialog.querySelector('[name="preset_key"]').value).toBe('custom');
    expect(dialog.querySelector('[name="command"]').value).toBe('.宗门点卯\n.闯塔');
    expect(dialog.querySelector('[name="interval_sec"]').value).toBe('86400');
    expect(dialog.querySelector('[name="count"]').value).toBe('3');
    expect(dialog.querySelector('[name="command_gap_sec"]').value).toBe('180');
    expect(dialog.querySelector('[name="auto_anchor"]').checked).toBe(false);
    expect(dialog.querySelector('[name="schedule_use_module_defaults"]').checked).toBe(false);
    expect(dialog.querySelector('#scheduleStatus').textContent).toBe('已套用联动模板: 点卯 + 闯塔');
  });

  test('renew overview scopes profiles to selected identity and toggle button disables profile', async () => {
    const schedule = window.MiniwebViews.schedule;
    const dialog = buildDialog();
    window.MiniwebState.state.identities = [
      { send_as_id: 101, label: 'Wise', account_local_id: 'main', enabled: true },
      { send_as_id: 202, label: 'Alt', account_local_id: 'alt', enabled: true },
    ];
    window.MiniwebState.state.accounts = [
      { local_id: 'main', label: 'Main' },
      { local_id: 'alt', label: 'AltAccount' },
    ];
    const profiles = [
      {
        id: 11,
        send_as_id: 101,
        account_local_id: 'main',
        preset_key: 'checkin',
        module_key: 'checkin',
        label: '点卯',
        enabled: true,
        state_contract: { semiauto_ready: true },
      },
      {
        id: 22,
        send_as_id: 202,
        account_local_id: 'alt',
        preset_key: 'wild_training',
        module_key: 'wild_training',
        label: '野外历练',
        enabled: true,
        state_contract: { semiauto_ready: true },
      },
    ];
    window.MiniwebApi.fetchJson.mockImplementation((url) => {
      if (url === '/api/schedule/renew') {
        return Promise.resolve({
          ok: true,
          profiles,
          allowed_presets: [
            { preset_key: 'checkin', module_key: 'checkin', interval_sec: 86400 },
            { preset_key: 'lingxiao_elder', module_key: 'tianti_climb', interval_sec: 10800 },
          ],
          worker: { running: true, last_result: { ok: true } },
        });
      }
      return Promise.resolve({ ok: true, batches: [] });
    });
    window.MiniwebApi.postJson.mockResolvedValue({
      ok: true,
      profiles: [{ ...profiles[0], enabled: false }, profiles[1]],
    });

    schedule.bindScheduleModal(
      { state: window.MiniwebState.state },
      dialog,
      [
        { key: 'checkin', label: '点卯', description: '每日点卯', fields: [], module_key: 'checkin' },
        { key: 'lingxiao_elder', label: '凌霄宫·长老', description: '长老包', fields: [], module_key: 'tianti_climb' },
      ],
      [],
      [],
      { modules: [], by_identity: [] }
    );
    await Promise.resolve();
    await Promise.resolve();

    const overview = dialog.querySelector('#scheduleRenewOverview');
    expect(overview.textContent).toContain('点卯');
    expect(overview.textContent).not.toContain('野外历练');
    expect(overview.textContent).toContain('其它身份 1 条已收起');
    expect(dialog.querySelectorAll('.schedule-renew-profile-group')).toHaveLength(2);
    expect(dialog.querySelector('.schedule-renew-profile-group').textContent).toContain('Main');

    const toggle = overview.querySelector('[data-schedule-renew-overview-action="toggle-profile"][data-profile-id="11"]');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(window.MiniwebApi.postJson).toHaveBeenCalledWith(
      '/api/schedule/renew/save',
      expect.objectContaining({ id: 11, enabled: false, preset_key: 'checkin' })
    );
    expect(dialog.querySelector('#scheduleRenewStatus').textContent).toContain('已关闭续期策略 #11');
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
