/**
 * Curated cross-browser catalog of popular extensions.
 * Bridges Chrome Web Store IDs (32-char a-p), Firefox Add-on GUIDs, and Firefox AMO slugs
 * so extensions match seamlessly between Chromium browsers and Firefox even if their
 * store names or IDs differ.
 */

export const KNOWN_EXTENSIONS_CATALOG = [
  {
    key: 'ublock-origin',
    name: 'uBlock Origin',
    chromiumId: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
    edgeId: 'odfafepnkmbhccpbejgmiehpchacaeak',
    firefoxId: 'uBlock0@raymondhill.net',
    firefoxSlug: 'ublock-origin',
    xpiFile: 'xpi-files/ublock-origin.xpi'
  },
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
    key: 'dark-reader',
    name: 'Dark Reader',
    chromiumId: 'eimadpbcbfnmbkopoojfekhnkhdbieeh',
    edgeId: 'ifoakfbpdcdoeenechcleahebpibofpc',
    firefoxId: 'addon@darkreader.org',
    firefoxSlug: 'darkreader',
    xpiFile: 'xpi-files/dark-reader.xpi'
  },
  {
    key: '1password',
    name: '1Password – Password Manager',
    aliases: ['1Password: Password Manager', '1Password'],
    chromiumId: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
    edgeId: 'dppgmdbiimibapkepcbdbmkaabgiofem',
    firefoxId: '{d634138d-c276-4fc8-924b-40a0ea21d284}',
    firefoxSlug: '1password-x-password-manager',
    xpiFile: 'xpi-files/1password.xpi'
  },
  {
    key: 'violentmonkey',
    name: 'Violentmonkey',
    chromiumId: 'jinjaccalgkegednnccohejagnlnfdag',
    edgeId: 'eeagobfjdenkkddmbclomhiblgggliao',
    firefoxId: '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}',
    firefoxSlug: 'violentmonkey',
    xpiFile: 'xpi-files/violentmonkey.xpi'
  },
  {
    key: 'tampermonkey',
    name: 'Tampermonkey',
    chromiumId: 'dhdgffkkebhmkfjojejmpbldmpobfkfo',
    edgeId: 'iikmkjmpaadaobahmlepeloendndfphd',
    firefoxId: 'firefox@tampermonkey.net',
    firefoxSlug: 'tampermonkey',
    xpiFile: 'xpi-files/tampermonkey.xpi'
  },
  {
    key: 'stylus',
    name: 'Stylus',
    chromiumId: 'clngdbkpkpeebahjckkjfobafhncgmne',
    firefoxId: '{7a7a4a92-a2a0-41d1-9fd7-1e92480d612d}',
    firefoxSlug: 'styl-us',
    xpiFile: 'xpi-files/stylus.xpi'
  },
  {
    key: 'react-developer-tools',
    name: 'React Developer Tools',
    chromiumId: 'fmkadmapgofadopljbjfkapdkoienihi',
    firefoxId: '@react-devtools',
    firefoxSlug: 'react-devtools',
    xpiFile: 'xpi-files/react-developer-tools.xpi'
  },
  {
    key: 'redux-devtools',
    name: 'Redux DevTools',
    chromiumId: 'lmhkpmbekcpmknklioeibfkpmmfibljd',
    firefoxId: 'extension@redux.devtools',
    firefoxSlug: 'reduxdevtools',
    xpiFile: 'xpi-files/redux-devtools.xpi'
  },
  {
    key: 'vuejs-devtools',
    name: 'Vue.js devtools',
    chromiumId: 'nhdogjmejiglipccpnnnanhbledajbpd',
    firefoxId: '{5caff8cc-3d2e-4110-a88a-003cc85b3858}',
    firefoxSlug: 'vue-js-devtools',
    xpiFile: 'xpi-files/vuejs-devtools.xpi'
  },
  {
    key: 'privacy-badger',
    name: 'Privacy Badger',
    chromiumId: 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp',
    firefoxId: 'jid1-MnnxcxisBPnSXQ@jetpack',
    firefoxSlug: 'privacy-badger17',
    xpiFile: 'xpi-files/privacy-badger.xpi'
  },
  {
    key: 'ghostery',
    name: 'Ghostery Tracker & Ad Blocker',
    aliases: ['Ghostery – Privacy Ad Blocker', 'Ghostery'],
    chromiumId: 'mlomiejdfkolichcflejclcbmpeaniij',
    firefoxId: 'firefox@ghostery.com',
    firefoxSlug: 'ghostery',
    xpiFile: 'xpi-files/ghostery.xpi'
  },
  {
    key: 'sponsorblock',
    name: 'SponsorBlock for YouTube - Skip Sponsorships',
    aliases: ['SponsorBlock for YouTube'],
    chromiumId: 'mnjggcdmjocbbbhaepdhchncahnbgone',
    firefoxId: 'sponsorBlocker@ajay.app',
    firefoxSlug: 'sponsorblock',
    xpiFile: 'xpi-files/sponsorblock.xpi'
  },
  {
    key: 'return-youtube-dislike',
    name: 'Return YouTube Dislike',
    chromiumId: 'gebbhagfogifgggkldgodflihgfeippi',
    firefoxId: '{762f9885-5a13-4abd-9c77-433dcd38b8fd}',
    firefoxSlug: 'return-youtube-dislikes',
    xpiFile: 'xpi-files/return-youtube-dislike.xpi'
  },
  {
    key: 'clearurls',
    name: 'ClearURLs',
    chromiumId: 'lckanjgmijmafbedllaakclkaicjfmnk',
    firefoxId: '{74145f27-f039-47ce-a470-a662b129930a}',
    firefoxSlug: 'clearurls',
    xpiFile: 'xpi-files/clearurls.xpi'
  },
  {
    key: 'decentraleyes',
    name: 'Decentraleyes',
    chromiumId: 'ldpochfccmkkmhdbclfhpagapcfdljkj',
    firefoxId: 'jid1-BoFifL9Vbdl2zQ@jetpack',
    firefoxSlug: 'decentraleyes',
    xpiFile: 'xpi-files/decentraleyes.xpi'
  },
  {
    key: 'consent-o-matic',
    name: 'Consent-O-Matic',
    chromiumId: 'mdjildafknihdffpkfmmpnpoiajfjnjd',
    firefoxId: 'gdpr@cavi.au.dk',
    firefoxSlug: 'consent-o-matic',
    xpiFile: 'xpi-files/consent-o-matic.xpi'
  },
  {
    key: 'vimium',
    name: 'Vimium',
    aliases: ['Vimium-FF'],
    chromiumId: 'dbepggeogbaibhgnhhndojpepiihcmeb',
    firefoxId: '{d7742d87-e61d-4b78-b8a1-b469842139fa}',
    firefoxSlug: 'vimium-ff',
    xpiFile: 'xpi-files/vimium.xpi'
  },
  {
    key: 'singlefile',
    name: 'SingleFile',
    chromiumId: 'mpiodijhokgodhhofbcjdecpffjipkle',
    firefoxId: '{531906d3-e22f-4a6c-a102-8057b88a1a63}',
    firefoxSlug: 'single-file',
    xpiFile: 'xpi-files/singlefile.xpi'
  },
  {
    key: 'refined-github',
    name: 'Refined GitHub',
    chromiumId: 'hlepfoohegkhhmjieoechaddaejaokhf',
    firefoxId: '{a4c4eda4-fb84-4a84-b4a1-f7c1cbf2a1ad}',
    firefoxSlug: 'refined-github-',
    xpiFile: 'xpi-files/refined-github.xpi'
  },
  {
    key: 'languagetool',
    name: 'AI Grammar Checker & Paraphraser – LanguageTool',
    aliases: ['Grammar and Spell Checker - LanguageTool', 'LanguageTool'],
    chromiumId: 'oldceeleldhonbafppcapldpdifcinji',
    firefoxId: 'languagetool-webextension@languagetool.org',
    firefoxSlug: 'languagetool',
    xpiFile: 'xpi-files/languagetool.xpi'
  },
  {
    key: 'proton-pass',
    name: 'Proton Pass: Free Password Manager',
    aliases: ['Proton Pass'],
    chromiumId: 'ghmbeldphafepmbegfdlkpapadhbakde',
    firefoxId: '78272b6fa58f4a1abaac99321d503a20@proton.me',
    firefoxSlug: 'proton-pass',
    xpiFile: 'xpi-files/proton-pass.xpi'
  },
  {
    key: 'raindrop-io',
    name: 'Raindrop.io',
    chromiumId: 'ldgfbffkinooeloadekpmfoklnobpien',
    firefoxId: 'jid0-adyhmvsP91nUO8pRv0Mn2VKeB84@jetpack',
    firefoxSlug: 'raindropio',
    xpiFile: 'xpi-files/raindrop-io.xpi'
  },
  {
    key: 'obsidian-web-clipper',
    name: 'Obsidian Web Clipper',
    chromiumId: 'cnjifjpddelmedmihgijeibhnjfabmlf',
    firefoxId: 'clipper@obsidian.md',
    firefoxSlug: 'web-clipper-obsidian',
    xpiFile: 'xpi-files/obsidian-web-clipper.xpi'
  },
  {
    key: 'reddit-enhancement-suite',
    name: 'Reddit Enhancement Suite',
    chromiumId: 'kbmfpngjjgdllneeigpgjifpgocmfgmb',
    firefoxId: 'jid1-xUfzOsOFlzSOXg@jetpack',
    firefoxSlug: 'reddit-enhancement-suite',
    xpiFile: 'xpi-files/reddit-enhancement-suite.xpi'
  },
  {
    key: 'enhancer-for-youtube',
    name: 'Enhancer for YouTube™',
    aliases: ['Enhancer for YouTube'],
    chromiumId: 'ponfpcnoihfmfllpaingbgckeeldkhle',
    firefoxId: 'enhancerforyoutube@maximerf.addons.mozilla.org',
    firefoxSlug: 'enhancer-for-youtube',
    xpiFile: 'xpi-files/enhancer-for-youtube.xpi'
  },
  {
    key: 'wappalyzer',
    name: 'Wappalyzer - Technology profiler',
    aliases: ['Wappalyzer'],
    chromiumId: 'gppongmhjkpfnbhagpmjfkannfbllamg',
    firefoxId: 'wappalyzer@crunchlabz.com',
    firefoxSlug: 'wappalyzer',
    xpiFile: 'xpi-files/wappalyzer.xpi'
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
    key: 'video-download-helper',
    name: 'Video Download Helper',
    chromiumId: 'lmjnegcaeklhafolokijcfjliaokphfk',
    firefoxId: '{b9db16a4-6edc-47ec-a1f4-b86292ed211d}',
    firefoxSlug: 'video-downloadhelper',
    xpiFile: 'xpi-files/video-download-helper.xpi'
  },
  {
    key: 'adguard-adblocker',
    name: 'AdGuard AdBlocker',
    chromiumId: 'bgnkhhnnamicmpeenaelnjfhikgbkllg',
    firefoxId: 'adguardadblocker@adguard.com',
    firefoxSlug: 'adguard-adblocker',
    xpiFile: 'xpi-files/adguard-adblocker.xpi'
  }
];
