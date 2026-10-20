(function () {
  const S = window.Swarm;
  S.buildConnect(document.getElementById('connect-card'), { prefix: 'page' });
  // The maintenance banner is driven by /api/stats; if that fails the page simply shows no banner.
  S.getJson('/api/stats').then(S.showBanner).catch(function () {});
})();
