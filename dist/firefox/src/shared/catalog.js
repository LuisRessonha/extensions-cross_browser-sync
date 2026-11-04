/**
 * Curated cross-browser catalog of popular extensions.
 * Bridges Chrome Web Store IDs (32-char a-p), Firefox Add-on GUIDs, and Firefox AMO slugs
 * so extensions match seamlessly between Chromium browsers and Firefox even if their
 * store names or IDs differ.
 */

export const KNOWN_EXTENSIONS_CATALOG = [
  {
    key: 'bitwarden',
    name: 'Bitwarden Password Manager',
    aliases: ['Bitwarden - Free Password Manager', 'Bitwarden'],
    chromiumId: 'nngceckbapebfimnlniiiahkandclblb',
    edgeId: 'jbkfoedolllekgbhcbcoahefnbanhhlh',
    firefoxId: '{446900e4-71c2-419f-a6a7-df9c091e268b}',
    firefoxSlug: 'bitwarden-password-manager',
    xpiFile: 'xpi-files/bitwarden.xpi'
  },
  {
    key: 'ublock-origin-lite',
    name: 'uBlock Origin Lite',
    chromiumId: 'ddkjiahejlhfcafbddmgiahcphecmpfh',
    firefoxId: 'uBOLiteRedux@raymondhill.net',
    firefoxSlug: 'ublock-origin-lite',
    xpiFile: 'xpi-files/ublock-origin-lite.xpi'
  },
  {
    key: 'udemy',
    name: 'Udemy - Improved Course Library',
    aliases: ['Udemy'],
    chromiumId: 'dmlfcanjgejpgjajoiepgfglmjcnhhlh',
    firefoxId: '{e8ca5e09-cd73-43aa-a313-4a75af598960}',
    firefoxSlug: 'udemy-improved-course-library',
    xpiFile: 'xpi-files/udemy.xpi'
  },
  {
    key: 'i-still-don-t-care-about-cookies',
    name: 'I still don\'t care about cookies',
    chromiumId: 'edibdbjcniadpccecjdfdjjppcpchdlm',
    firefoxId: 'idcac-pub@guus.ninja',
    firefoxSlug: 'istilldontcareaboutcookies',
    xpiFile: 'xpi-files/i-still-don-t-care-about-cookies.xpi'
  },
  {
    key: 'buster',
    name: 'Buster: Captcha Solver for Humans',
    aliases: ['Buster'],
    chromiumId: 'mpbjkejclgfgadiemmefgebjfooflfhl',
    firefoxId: '{e58d3966-3d76-4cd9-8552-1582fbc800c1}',
    firefoxSlug: 'buster-captcha-solver',
    xpiFile: 'xpi-files/buster.xpi'
  },
  {
    key: 'demandware-with-ease',
    name: 'Demandware With Ease',
    chromiumId: 'ffhabonelknmejmdnekedmijlhebpcio',
    firefoxId: 'dwithease@forkpoint.com',
    firefoxSlug: 'dwithease',
    xpiFile: 'xpi-files/demandware-with-ease.xpi'
  }
];
