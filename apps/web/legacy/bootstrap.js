/* ES5 only: executes before the game and its polyfills; allowed by script-src 'self'. */
(function () {
  'use strict';
  var box = document.getElementById('legacy-diagnostics');
  var status = document.getElementById('legacy-status');
  var detail = document.getElementById('legacy-error');
  var failed = false;
  var ready = false;
  function stage(text) {
    if (!failed) status.textContent = text;
  }
  function fail(error) {
    failed = true;
    box.style.display = 'block';
    box.setAttribute('data-state', 'error');
    status.textContent = 'ERROR 兼容版未能正常运行，请拍下此诊断区反馈。';
    detail.style.display = 'block';
    detail.textContent = (
      String((error && error.message) || error) + (error && error.stack ? '\n' + error.stack : '')
    ).slice(0, 1800);
  }
  window.DeskParkLegacy = {
    stage: stage,
    fail: fail,
    ready: function () {
      ready = true;
      if (!failed) {
        box.setAttribute('data-state', 'ready');
        stage('L3 READY 游戏界面已显示');
        box.style.display = /(?:\?|&)debug=1(?:&|$)/.test(window.location.search)
          ? 'block'
          : 'none';
      }
    },
  };
  window.addEventListener(
    'error',
    function (event) {
      var target = event.target;
      if (target && target.tagName === 'SCRIPT') {
        fail('SCRIPT LOAD ERROR: ' + target.src);
      } else if (event.message || event.error) {
        fail(
          String(event.message || event.error) +
            '\n' +
            (event.filename || '') +
            ':' +
            (event.lineno || 0) +
            ':' +
            (event.colno || 0),
        );
      }
    },
    true,
  );
  window.addEventListener('unhandledrejection', function (event) {
    fail(event.reason || 'Unhandled promise rejection');
  });
  stage('L1 BOOT 诊断脚本已运行，正在加载游戏');
  window.setTimeout(function () {
    if (!ready && !failed)
      fail(
        'STARTUP TIMEOUT (15s): ' + status.textContent + '\n请反馈此处停留的 L0 / L1 / L2 阶段。',
      );
  }, 15000);
})();
