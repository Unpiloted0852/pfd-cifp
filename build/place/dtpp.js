/*
 * The FAA's chart list (d-TPP_Metafile.xml), reduced to the approach charts.
 *
 * Read with patterns, not an XML parser: the file is machine-written, one
 * element per line, and this repository has no dependencies it can avoid.
 *
 *   charts(xml) -> { cycle, list: [{ id, mil, civil, name, pdf }] }
 *
 * `id` is the identifier the extension asks by: the ICAO one where the
 * airport has one, the FAA's otherwise.
 */
'use strict';

function charts(xml) {
  var cyc = /<digital_tpp cycle="(\d{4})"/.exec(xml);
  var list = [], reA = /<airport_name ID="[^"]*" military="([^"]*)" apt_ident="([^"]*)" icao_ident="([^"]*)"[^>]*>([\s\S]*?)<\/airport_name>/g, m;
  while ((m = reA.exec(xml))) {
    var reR = /<record>([\s\S]*?)<\/record>/g, r;
    while ((r = reR.exec(m[4]))) {
      var body = r[1];
      var t = function (k) { var q = new RegExp('<' + k + '>([^<]*)</' + k + '>').exec(body); return q ? q[1].trim().replace(/&amp;/g, '&') : ''; };
      if (t('chart_code') !== 'IAP') continue;
      var pdf = t('pdf_name');
      if (!/^[A-Za-z0-9_]+\.pdf$/i.test(pdf)) continue;
      list.push({ id: (m[3] || m[2]).trim().toUpperCase(), mil: m[1], civil: t('civil'), name: t('chart_name'), pdf: pdf.toLowerCase() });
    }
  }
  return { cycle: cyc ? cyc[1] : null, list: list };
}

/*
 * Which of them might carry no georeferencing.
 *
 * The list does not say. What it does say is who drew the chart: the FAA's
 * own approach plates are georeferenced, all of them; the ones that are not
 * are the Department of Defense's (a military field, or a chart not marked
 * civil) and the charted visual procedures. Those are fetched and looked at;
 * the other ten thousand are not. Continuation pages have no plan view.
 */
function candidates(list) {
  return list.filter(function (c) {
    if (/\bCONT\.\s*\d/.test(c.name)) return false;
    return c.mil !== 'N' || c.civil !== 'C' || /\bVISUAL\b/.test(c.name);
  });
}

module.exports = { charts: charts, candidates: candidates };
