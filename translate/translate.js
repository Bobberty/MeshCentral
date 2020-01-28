/**
* @description MeshCentral MeshAgent
* @author Ylian Saint-Hilaire
* @copyright Intel Corporation 2019-2020
* @license Apache-2.0
* @version v0.0.1
*/

var fs = require('fs');
var path = require('path');
var performCheck = false;
var translationTable = null;
var sourceStrings = null;
var jsdom = null; //require('jsdom');
var esprima = null; //require('esprima'); // https://www.npmjs.com/package/esprima
var minifyLib = 2; // 0 = None, 1 = minify-js, 2 = HTMLMinifier
var minify = null;

var meshCentralSourceFiles = [
    "../views/agentinvite.handlebars",
    "../views/default.handlebars",
    "../views/default-mobile.handlebars",
    "../views/download.handlebars",
    "../views/error404.handlebars",
    "../views/error404-mobile.handlebars",
    "../views/login.handlebars",
    "../views/login-mobile.handlebars",
    "../views/terms.handlebars",
    "../views/terms-mobile.handlebars",
    "../views/xterm.handlebars",
    "../views/message.handlebars",
    "../views/messenger.handlebars",
    "../public/player.htm"
];

// True is this module is run directly using NodeJS
var directRun = (require.main === module);

// Check NodeJS version
const NodeJSVer = Number(process.version.match(/^v(\d+\.\d+)/)[1]);
if (directRun && (NodeJSVer < 8)) { log("Translate.js requires Node v8 or above, current version is " + process.version + "."); return; }

// node translate.json CHECK ../meshcentral/views/default.handlebars
// node translate.json EXTRACT bob.json ../meshcentral/views/default.handlebars
// node translate.js TRANSLATE fr test2.json ../meshcentral/views/default.handlebars

var worker = null;
function log() {
    if (worker == null) {
        console.log(...arguments);
    } else {
        worker.parentPort.postMessage({ msg: arguments[0] })
    }
}

if (directRun && (NodeJSVer >= 12)) {
    const xworker = require('worker_threads');
    try {
        if (xworker.isMainThread == false) {
            // We are being called to do some work
            worker = xworker;
            const op = worker.workerData.op;
            const args = worker.workerData.args;

            // Get things setup
            jsdom = require('jsdom');
            esprima = require('esprima'); // https://www.npmjs.com/package/esprima
            if (minifyLib == 1) { minify = require('minify-js'); }
            if (minifyLib == 2) { minify = require('html-minifier').minify; } // https://www.npmjs.com/package/html-minifier

            switch (op) {
                case 'translate': {
                    translateSingleThreaded(args[0], args[1], args[2], args[3]);
                    break;
                }
            }
            return;
        }
    } catch (ex) { log(ex); }
}

if (directRun) { setup(); }

function setup() {
    var libs = ['jsdom', 'esprima', 'minify-js'];
    if (minifyLib == 1) { libs.push('minify-js'); }
    if (minifyLib == 2) { libs.push('html-minifier'); }
    InstallModules(libs, start);
}

function start() { startEx(process.argv); }

function startEx(argv) {
    // Load dependencies
    jsdom = require('jsdom');
    esprima = require('esprima'); // https://www.npmjs.com/package/esprima
    if (minifyLib == 1) { minify = require('minify-js'); }
    if (minifyLib == 2) { minify = require('html-minifier').minify; } // https://www.npmjs.com/package/html-minifier

    var command = null;
    if (argv.length > 2) { command = argv[2].toLowerCase(); }
    if (['check', 'extract', 'extractall', 'translate', 'translateall', 'minifyall', 'merge', 'totext', 'fromtext'].indexOf(command) == -1) { command = null; }

    if (directRun) { log('MeshCentral web site translator'); }
    if (command == null) {
        log('Usage "node translate.js [command] [options]');
        log('Possible commands:');
        log('');
        log('  CHECK [files]');
        log('    Check will pull string out of a web page and display a report.');
        log('');
        log('  EXTRACT [languagefile] [files]');
        log('    Extract strings from web pages and generate a language (.json) file.');
        log('');
        log('  EXTRACTALL (languagefile)');
        log('    Extract all MeshCentral strings from web pages and generate the languages.json file.');
        log('');
        log('  TRANSLATE [language] [languagefile] [files]');
        log('    Use a language (.json) file to translate web pages to a give language.');
        log('');
        log('  TRANSLATEALL (languagefile) (language code)');
        log('    Translate all MeshCentral strings using the languages.json file.');
        log('');
        log('  MINIFYALL');
        log('    Minify the main MeshCentral english web pages.');
        log('');
        log('  MERGE [sourcefile] [targetfile] [language code]');
        log('    Merge a language from a translation file into another translation file.');
        log('');
        log('  TOTEXT [translationfile] [textfile] [language code]');
        log('    Save a text for with all strings of a given language.');
        log('');
        log('  FROMTEXT [translationfile] [textfile] [language code]');
        log('    Import raw text string as translations for a language code.');
        process.exit();
        return;
    }

    // Extract strings from web pages and display a report
    if (command == 'check') {
        var sources = [];
        for (var i = 3; i < argv.length; i++) { if (fs.existsSync(argv[i]) == false) { log('Missing file: ' + argv[i]); process.exit(); return; } sources.push(argv[i]); }
        if (sources.length == 0) { log('No source files specified.'); process.exit(); return; }
        performCheck = true;
        sourceStrings = {};
        for (var i = 0; i < sources.length; i++) { extractFromHtml(sources[i]); }
        var count = 0;
        for (var i in sourceStrings) { count++; }
        log('Extracted ' + count + ' strings.');
        process.exit();
        return;
    }

    // Extract strings from web pages
    if (command == 'extract') {
        if (argv.length < 4) { log('No language file specified.'); process.exit(); return; }
        var sources = [];
        for (var i = 4; i < argv.length; i++) { if (fs.existsSync(argv[i]) == false) { log('Missing file: ' + argv[i]); process.exit(); return; } sources.push(argv[i]); }
        if (sources.length == 0) { log('No source files specified.'); process.exit(); return; }
        extract(argv[3], sources);
    }

    // Save a text file with all the strings for a given language
    if (command == 'totext') {
        if ((argv.length == 6)) {
            if (fs.existsSync(argv[3]) == false) { log('Unable to find: ' + argv[3]); return; }
            totext(argv[3], argv[4], argv[5]);
        } else {
            log('Usage: TOTEXT [translationfile] [textfile] [language code]');
        }
        return;
    }

    // Read a text file and use it as translation for a given language
    if (command == 'fromtext') {
        if ((argv.length == 6)) {
            if (fs.existsSync(argv[3]) == false) { log('Unable to find: ' + argv[3]); return; }
            if (fs.existsSync(argv[4]) == false) { log('Unable to find: ' + argv[4]); return; }
            fromtext(argv[3], argv[4], argv[5]);
        } else {
            log('Usage: FROMTEXT [translationfile] [textfile] [language code]');
        }
        return;
    }

    // Merge one language from a language file into another language file.
    if (command == 'merge') {
        if ((argv.length == 6)) {
            if (fs.existsSync(argv[3]) == false) { log('Unable to find: ' + argv[3]); return; }
            if (fs.existsSync(argv[4]) == false) { log('Unable to find: ' + argv[4]); return; }
            merge(argv[3], argv[4], argv[5]);
        } else {
            log('Usage: MERGE [sourcefile] [tartgetfile] [language code]');
        }
        return;
    }

    // Extract or translate all MeshCentral strings
    if (command == 'extractall') {
        if (argv.length > 4) { lang = argv[4].toLowerCase(); }
        var translationFile = 'translate.json';
        if (argv.length > 3) {
            if (fs.existsSync(argv[3]) == false) { log('Unable to find: ' + argv[3]); return; } else { translationFile = argv[3]; }
        }
        extract(translationFile, meshCentralSourceFiles, translationFile);
    }

    if (command == 'translateall') {
        if (fs.existsSync('../views/translations') == false) { fs.mkdirSync('../views/translations'); }
        if (fs.existsSync('../public/translations') == false) { fs.mkdirSync('../public/translations'); }
        var lang = null;
        if (argv.length > 4) { lang = argv[4].toLowerCase(); }
        if (argv.length > 3) {
            if (fs.existsSync(argv[3]) == false) {
                log('Unable to find: ' + argv[3]);
            } else {
                translate(lang, argv[3], meshCentralSourceFiles, 'translations');
            }
        } else {
            if (fs.existsSync('translate.json') == false) {
                log('Unable to find translate.json.');
            } else {
                translate(lang, 'translate.json', meshCentralSourceFiles, 'translations');
            }
        }
        return;
    }

    // Translate web pages to a given language given a language file
    if (command == 'translate') {
        if (argv.length < 4) { log("No language specified."); process.exit(); return; }
        if (argv.length < 5) { log("No language file specified."); process.exit(); return; }
        var lang = argv[3].toLowerCase();
        var langFile = argv[4];
        if (fs.existsSync(langFile) == false) { log("Missing language file: " + langFile); process.exit(); return; }

        var sources = [], subdir = null;
        for (var i = 5; i < argv.length; i++) {
            if (argv[i].startsWith('--subdir:')) {
                subdir = argv[i].substring(9);
            } else {
                if (fs.existsSync(argv[i]) == false) { log("Missing file: " + argv[i]); process.exit(); return; } sources.push(argv[i]);
            }
        }
        if (sources.length == 0) { log("No source files specified."); process.exit(); return; }
        translate(lang, langFile, sources, subdir);
    }

    if (command == 'minifyall') {
        for (var i in meshCentralSourceFiles) {
            var outname = meshCentralSourceFiles[i];
            var outnamemin = null;
            if (outname.endsWith('.handlebars')) {
                outnamemin = (outname.substring(0, outname.length - 11) + '-min.handlebars');
            } else if (outname.endsWith('.html')) {
                outnamemin = (outname.substring(0, outname.length - 5) + '-min.html');
            } else if (outname.endsWith('.htm')) {
                outnamemin = (outname.substring(0, outname.length - 4) + '-min.htm');
            } else {
                outnamemin = (outname, outname + '.min');
            }
            log('Generating ' + outnamemin + '...');

            // Minify the file
            if (minifyLib = 2) {
                var minifiedOut = minify(fs.readFileSync(outname).toString(), {
                    collapseBooleanAttributes: true,
                    collapseInlineTagWhitespace: false, // This is not good.
                    collapseWhitespace: true,
                    minifyCSS: true,
                    minifyJS: true,
                    removeComments: true,
                    removeOptionalTags: true,
                    removeEmptyAttributes: true,
                    removeAttributeQuotes: true,
                    removeRedundantAttributes: true,
                    removeScriptTypeAttributes: true,
                    removeTagWhitespace: true,
                    preserveLineBreaks: false,
                    useShortDoctype: true
                });
                fs.writeFileSync(outnamemin, minifiedOut, { flag: 'w+' });
            }
        }
    }
}


function totext(source, target, lang) {
    // Load the source language file
    var sourceLangFileData = null;
    try { sourceLangFileData = JSON.parse(fs.readFileSync(source)); } catch (ex) { }
    if ((sourceLangFileData == null) || (sourceLangFileData.strings == null)) { log("Invalid source language file."); process.exit(); return; }

    log('Writing ' + lang + '...');

    // Generate raw text
    var output = [];
    var outputCharCount = 0; // Google has a 5000 character limit
    var splitOutput = [];
    var splitOutputPtr = 1;
    var count = 0;
    for (var i in sourceLangFileData.strings) {
        if ((sourceLangFileData.strings[i][lang] != null) && (sourceLangFileData.strings[i][lang].indexOf('\r') == -1) && (sourceLangFileData.strings[i][lang].indexOf('\n') == -1)) {
            output.push(sourceLangFileData.strings[i][lang]);
            outputCharCount += (sourceLangFileData.strings[i][lang].length + 2);
            if (outputCharCount > 4500) { outputCharCount = 0; splitOutputPtr++; }
            if (splitOutput[splitOutputPtr] == null) { splitOutput[splitOutputPtr] = []; }
            splitOutput[splitOutputPtr].push(sourceLangFileData.strings[i][lang]);
        } else {
            output.push('');
            outputCharCount += 2;
            if (outputCharCount > 4500) { outputCharCount = 0; splitOutputPtr++; }
            if (splitOutput[splitOutputPtr] == null) { splitOutput[splitOutputPtr] = []; }
            splitOutput[splitOutputPtr].push('');
        }
        count++;
    }

    if (splitOutputPtr == 1) {
        // Save the target back
        fs.writeFileSync(target + '-' + lang + '.txt', output.join('\r\n'), { flag: 'w+' });
        log('Done.');
    } else {
        // Save the text in 1000 string bunches
        for (var i in splitOutput) {
            log('Writing ' + target + '-' + lang + '-' + i + '.txt...');
            fs.writeFileSync(target + '-' + lang + '-' + i + '.txt', splitOutput[i].join('\r\n'), { flag: 'w+' });
        }
        log('Done.');
    }
}

function fromtext(source, target, lang) {
    // Load the source language file
    var sourceLangFileData = null;
    try { sourceLangFileData = JSON.parse(fs.readFileSync(source)); } catch (ex) { }
    if ((sourceLangFileData == null) || (sourceLangFileData.strings == null)) { log("Invalid source language file."); process.exit(); return; }

    log('Updating ' + lang + '...');

    // Read raw text
    var rawText = fs.readFileSync(target).toString('utf8');
    var rawTextArray = rawText.split('\r\n');
    var rawTextPtr = 0;

    log('Translation file: ' + sourceLangFileData.strings.length + ' string(s)');
    log('Text file: ' + rawTextArray.length + ' string(s)');
    if (sourceLangFileData.strings.length != rawTextArray.length) { log('String count mismatch, unable to import.'); process.exit(1); return; }

    var output = [];
    var splitOutput = [];
    for (var i in sourceLangFileData.strings) {
        if ((sourceLangFileData.strings[i]['en'] != null) && (sourceLangFileData.strings[i]['en'].indexOf('\r') == -1) && (sourceLangFileData.strings[i]['en'].indexOf('\n') == -1)) {
            if (sourceLangFileData.strings[i][lang] == null) { sourceLangFileData.strings[i][lang] = rawTextArray[i]; }
        }
    }

    fs.writeFileSync(source + '-new', translationsToJson(sourceLangFileData), { flag: 'w+' });
    log('Done.');
}

function merge(source, target, lang) {
    // Load the source language file
    var sourceLangFileData = null;
    try { sourceLangFileData = JSON.parse(fs.readFileSync(source)); } catch (ex) { }
    if ((sourceLangFileData == null) || (sourceLangFileData.strings == null)) { log("Invalid source language file."); process.exit(); return; }

    // Load the target language file
    var targetLangFileData = null;
    try { targetLangFileData = JSON.parse(fs.readFileSync(target)); } catch (ex) { }
    if ((targetLangFileData == null) || (targetLangFileData.strings == null)) { log("Invalid target language file."); process.exit(); return; }

    log('Merging ' + lang + '...');

    // Index the target file
    var index = {};
    for (var i in targetLangFileData.strings) { if (targetLangFileData.strings[i].en != null) { index[targetLangFileData.strings[i].en] = targetLangFileData.strings[i]; } }

    // Merge the translation
    for (var i in sourceLangFileData.strings) {
        if ((sourceLangFileData.strings[i].en != null) && (sourceLangFileData.strings[i][lang] != null) && (index[sourceLangFileData.strings[i].en] != null)) {
            //if (sourceLangFileData.strings[i][lang] == null) {
                index[sourceLangFileData.strings[i].en][lang] = sourceLangFileData.strings[i][lang];
            //}
        }
    }

    // Deindex the new target file
    var targetData = { strings: [] };
    for (var i in index) { targetData.strings.push(index[i]); }

    // Save the target back
    fs.writeFileSync(target, translationsToJson(targetData), { flag: 'w+' });
    log('Done.');
}

function translate(lang, langFile, sources, createSubDir) {
    if (directRun && (NodeJSVer >= 12) && (lang == null)) {
        // Multi threaded translation
        log("Multi-threaded translation.");

        // Load the language file
        var langFileData = null;
        try { langFileData = JSON.parse(fs.readFileSync(langFile)); } catch (ex) { }
        if ((langFileData == null) || (langFileData.strings == null)) { log("Invalid language file."); process.exit(); return; }

        langs = {};
        for (var i in langFileData.strings) { var entry = langFileData.strings[i]; for (var j in entry) { if ((j != 'en') && (j != 'xloc') && (j != '*')) { langs[j.toLowerCase()] = true; } } }
        for (var i in langs) {
            const { Worker } = require('worker_threads')
            const worker = new Worker('./translate.js', { stdout: true, workerData: { op: 'translate', args: [i, langFile, sources, createSubDir] } });
            worker.stdout.on('data', function (msg) { console.log('wstdio:', msg.toString()); });
            worker.on('message', function (message) { console.log(message.msg); });
            worker.on('error', function (error) { console.log('error', error); });
            worker.on('exit', function (code) { /*console.log('exit', code);*/ })
        }
    } else {
        // Single threaded translation
        translateSingleThreaded(lang, langFile, sources, createSubDir);
    }
}

function translateSingleThreaded(lang, langFile, sources, createSubDir) {
    // Load the language file
    var langFileData = null;
    try { langFileData = JSON.parse(fs.readFileSync(langFile)); } catch (ex) { }
    if ((langFileData == null) || (langFileData.strings == null)) { log("Invalid language file."); process.exit(); return; }

    if ((lang != null) && (lang != '*')) {
        // Translate a single language
        translateEx(lang, langFileData, sources, createSubDir);
    } else {
        // See that languages are in the translation file
        langs = {};
        for (var i in langFileData.strings) { var entry = langFileData.strings[i]; for (var j in entry) { if ((j != 'en') && (j != 'xloc') && (j != '*')) { langs[j.toLowerCase()] = true; } } }
        for (var i in langs) { translateEx(i, langFileData, sources, createSubDir); }
    }

    //process.exit();
    return;
}

function translateEx(lang, langFileData, sources, createSubDir) {
    // Build translation table, simple source->target for the given language.
    translationTable = {};
    for (var i in langFileData.strings) {
        var entry = langFileData.strings[i];
        if ((entry['en'] != null) && (entry[lang] != null)) { translationTable[entry['en']] = entry[lang]; }
    }
    // Translate the files
    for (var i = 0; i < sources.length; i++) { translateFromHtml(lang, sources[i], createSubDir); }
}


function extract(langFile, sources) {
    sourceStrings = {};
    if (fs.existsSync(langFile) == true) {
        var langFileData = null;
        try { langFileData = JSON.parse(fs.readFileSync(langFile)); } catch (ex) { }
        if ((langFileData == null) || (langFileData.strings == null)) { log("Invalid language file."); process.exit(); return; }
        for (var i in langFileData.strings) {
            sourceStrings[langFileData.strings[i]['en']] = langFileData.strings[i];
            delete sourceStrings[langFileData.strings[i]['en']].xloc;
        }
    }
    for (var i = 0; i < sources.length; i++) { extractFromHtml(sources[i]); }
    var count = 0, output = [];
    for (var i in sourceStrings) {
        count++;
        sourceStrings[i]['en'] = i;
        //if ((sourceStrings[i].xloc != null) && (sourceStrings[i].xloc.length > 0)) { output.push(sourceStrings[i]); } // Only save results that have a source location.
        output.push(sourceStrings[i]); // Save all results
    }
    fs.writeFileSync(langFile, translationsToJson({ strings: output }), { flag: 'w+' });
    log(format("{0} strings in output file.", count));
    process.exit();
    return;
}

function extractFromHtml(file) {
    var data = fs.readFileSync(file);
    var { JSDOM } = jsdom;
    const dom = new JSDOM(data, { includeNodeLocations: true });
    log("Processing HTML: " + path.basename(file));
    getStrings(path.basename(file), dom.window.document.querySelector('body'));
}

function getStrings(name, node) {
    for (var i = 0; i < node.childNodes.length; i++) {
        var subnode = node.childNodes[i];

        // Check if the "value" attribute exists and needs to be translated
        if ((subnode.attributes != null) && (subnode.attributes.length > 0)) {
            var subnodeignore = false, subnodevalue = null, subnodeplaceholder = null, subnodetitle = null;
            for (var j in subnode.attributes) {
                if ((subnode.attributes[j].name == 'type') && (subnode.attributes[j].value == 'hidden')) { subnodeignore = true; }
                if (subnode.attributes[j].name == 'value') { subnodevalue = subnode.attributes[j].value; }
                if (subnode.attributes[j].name == 'placeholder') { subnodeplaceholder = subnode.attributes[j].value; }
                if (subnode.attributes[j].name == 'title') { subnodetitle = subnode.attributes[j].value; }
            }
            if ((subnodevalue != null) && isNumber(subnodevalue) == true) { subnodevalue = null; }
            if ((subnodeplaceholder != null) && isNumber(subnodeplaceholder) == true) { subnodeplaceholder = null; }
            if ((subnodetitle != null) && isNumber(subnodetitle) == true) { subnodetitle = null; }
            if ((subnodeignore == false) && (subnodevalue != null)) {
                // Add a new string to the list (value)
                if (sourceStrings[subnodevalue] == null) { sourceStrings[subnodevalue] = { en: subnodevalue, xloc: [name] }; } else { if (sourceStrings[subnodevalue].xloc == null) { sourceStrings[subnodevalue].xloc = []; } sourceStrings[subnodevalue].xloc.push(name); }
            }
            if (subnodeplaceholder != null) {
                // Add a new string to the list (placeholder)
                if (sourceStrings[subnodeplaceholder] == null) { sourceStrings[subnodeplaceholder] = { en: subnodeplaceholder, xloc: [name] }; } else { if (sourceStrings[subnodeplaceholder].xloc == null) { sourceStrings[subnodeplaceholder].xloc = []; } sourceStrings[subnodeplaceholder].xloc.push(name); }
            }
            if (subnodetitle != null) {
                // Add a new string to the list (title)
                if (sourceStrings[subnodetitle] == null) { sourceStrings[subnodetitle] = { en: subnodetitle, xloc: [name] }; } else { if (sourceStrings[subnodetitle].xloc == null) { sourceStrings[subnodetitle].xloc = []; } sourceStrings[subnodetitle].xloc.push(name); }
            }
        }

        // Check the content of the element
        var subname = subnode.id;
        if (subname == null || subname == '') { subname = i; }
        if (subnode.hasChildNodes()) {
            getStrings(name + '->' + subname, subnode);
        } else {
            if (subnode.nodeValue == null) continue;
            var nodeValue = subnode.nodeValue.trim().split('\\r').join('').split('\\n').join('').trim();
            if ((nodeValue.length > 0) && (subnode.nodeType == 3)) {
                if ((node.tagName != 'SCRIPT') && (node.tagName != 'STYLE') && (nodeValue.length < 8000) && (nodeValue.startsWith('{{{') == false) && (nodeValue != ' ')) {
                    if (performCheck) { log('  "' + nodeValue + '"'); }
                    // Add a new string to the list
                    if (sourceStrings[nodeValue] == null) { sourceStrings[nodeValue] = { en: nodeValue, xloc: [name] }; } else { if (sourceStrings[nodeValue].xloc == null) { sourceStrings[nodeValue].xloc = []; } sourceStrings[nodeValue].xloc.push(name); }
                } else if (node.tagName == 'SCRIPT') {
                    // Parse JavaScript
                    getStringFromJavaScript(name, subnode.nodeValue);
                }
            }
        }
    }
}

function getStringFromJavaScript(name, script) {
    if (performCheck) { log(format('Processing JavaScript of {0} bytes: {1}', script.length, name)); }
    var tokenScript = esprima.tokenize(script), count = 0;
    for (var i in tokenScript) {
        var token = tokenScript[i];
        if ((token.type == 'String') && (token.value.length > 2) && (token.value[0] == '"')) {
            var str = token.value.substring(1, token.value.length - 1);
            //if (performCheck) { log('  ' + name + '->' + (++count), token.value); }
            if (performCheck) { log('  ' + token.value); }
            if (sourceStrings[str] == null) { sourceStrings[str] = { en: str, xloc: [name + '->' + (++count)] }; } else { if (sourceStrings[str].xloc == null) { sourceStrings[str].xloc = []; } sourceStrings[str].xloc.push(name + '->' + (++count)); }
        }
    }
}





function translateFromHtml(lang, file, createSubDir) {
    var data = fs.readFileSync(file);
    var { JSDOM } = jsdom;
    const dom = new JSDOM(data, { includeNodeLocations: true });
    log("Translating HTML (" + lang + "): " + path.basename(file));
    translateStrings(path.basename(file), dom.window.document.querySelector('body'));
    var out = dom.serialize();

    var outname = file;
    var outnamemin = null;
    if (createSubDir != null) {
        var outfolder = path.join(path.dirname(file), createSubDir);
        if (fs.existsSync(outfolder) == false) { fs.mkdirSync(outfolder); }
        outname = path.join(path.dirname(file), createSubDir, path.basename(file));
    }
    if (outname.endsWith('.handlebars')) {
        outnamemin = (outname.substring(0, outname.length - 11) + '-min_' + lang + '.handlebars');
        outname = (outname.substring(0, outname.length - 11) + '_' + lang + '.handlebars');
    } else if (outname.endsWith('.html')) {
        outnamemin = (outname.substring(0, outname.length - 5) + '-min_' + lang + '.html');
        outname = (outname.substring(0, outname.length - 5) + '_' + lang + '.html');
    } else if (outname.endsWith('.htm')) {
        outnamemin = (outname.substring(0, outname.length - 4) + '-min_' + lang + '.htm');
        outname = (outname.substring(0, outname.length - 4) + '_' + lang + '.htm');
    } else {
        outnamemin = (outname + '_' + lang + '.min');
        outname = (outname + '_' + lang);
    }
    fs.writeFileSync(outname, out, { flag: 'w+' });

    // Minify the file
    if (minifyLib == 1) {
        minify.file({
            file: outname,
            dist: outnamemin
        }, (e, compress) => {
            if (e) { log('ERROR ', e); return done(); }
            compress.run((e) => { e ? log('Minification fail', e) : log('Minification sucess'); minifyDone(); });
        }
        );
    }

    // Minify the file
    if (minifyLib = 2) {
        var minifiedOut = minify(out, {
            collapseBooleanAttributes: true,
            collapseInlineTagWhitespace: false, // This is not good.
            collapseWhitespace: true,
            minifyCSS: true,
            minifyJS: true,
            removeComments: true,
            removeOptionalTags: true,
            removeEmptyAttributes: true,
            removeAttributeQuotes: true,
            removeRedundantAttributes: true,
            removeScriptTypeAttributes: true,
            removeTagWhitespace: true,
            preserveLineBreaks: false,
            useShortDoctype: true
        });
        fs.writeFileSync(outnamemin, minifiedOut, { flag: 'w+' });
    }
}

function minifyDone() { log('Completed minification.'); }

function translateStrings(name, node) {
    for (var i = 0; i < node.childNodes.length; i++) {
        var subnode = node.childNodes[i];

        // Check if the "value" attribute exists and needs to be translated
        if ((subnode.attributes != null) && (subnode.attributes.length > 0)) {
            var subnodeignore = false, subnodevalue = null, subnodeindex = null, subnodeplaceholder = null, subnodeplaceholderindex = null, subnodetitle = null, subnodetitleindex = null;
            for (var j in subnode.attributes) {
                if ((subnode.attributes[j].name == 'type') && (subnode.attributes[j].value == 'hidden')) { subnodeignore = true; }
                if (subnode.attributes[j].name == 'value') { subnodevalue = subnode.attributes[j].value; subnodeindex = j; }
                if (subnode.attributes[j].name == 'placeholder') { subnodeplaceholder = subnode.attributes[j].value; subnodeplaceholderindex = j; }
                if (subnode.attributes[j].name == 'title') { subnodetitle = subnode.attributes[j].value; subnodetitleindex = j; }
            }
            if ((subnodevalue != null) && isNumber(subnodevalue) == true) { subnodevalue = null; }
            if ((subnodeplaceholder != null) && isNumber(subnodeplaceholder) == true) { subnodeplaceholder = null; }
            if ((subnodetitle != null) && isNumber(subnodetitle) == true) { subnodetitle = null; }
            if ((subnodeignore == false) && (subnodevalue != null)) {
                // Perform attribute translation for value
                if (translationTable[subnodevalue] != null) { subnode.attributes[subnodeindex].value = translationTable[subnodevalue]; }
            }
            if (subnodeplaceholder != null) {
                // Perform attribute translation for placeholder
                if (translationTable[subnodeplaceholder] != null) { subnode.attributes[subnodeplaceholderindex].value = translationTable[subnodeplaceholder]; }
            }
            if (subnodetitle != null) {
                // Perform attribute translation for title
                if (translationTable[subnodetitle] != null) { subnode.attributes[subnodetitleindex].value = translationTable[subnodetitle]; }
            }
        }

        var subname = subnode.id;
        if (subname == null || subname == '') { subname = i; }
        if (subnode.hasChildNodes()) {
            translateStrings(name + '->' + subname, subnode);
        } else {
            if (subnode.nodeValue == null) continue;
            var nodeValue = subnode.nodeValue.trim().split('\\r').join('').split('\\n').join('').trim();

            // Look for the front trim
            var frontTrim = '', backTrim = '';;
            var x1 = subnode.nodeValue.indexOf(nodeValue);
            if (x1 > 0) { frontTrim = subnode.nodeValue.substring(0, x1); }
            if (x1 != -1) { backTrim = subnode.nodeValue.substring(x1 + nodeValue.length); }

            if ((nodeValue.length > 0) && (subnode.nodeType == 3)) {
                if ((node.tagName != 'SCRIPT') && (node.tagName != 'STYLE') && (nodeValue.length < 8000) && (nodeValue.startsWith('{{{') == false) && (nodeValue != ' ')) {
                    // Check if we have a translation for this string
                    if (translationTable[nodeValue]) { subnode.nodeValue = (frontTrim + translationTable[nodeValue] + backTrim); }
                } else if (node.tagName == 'SCRIPT') {
                    // Translate JavaScript
                    subnode.nodeValue = translateStringsFromJavaScript(name, subnode.nodeValue);
                }
            }
        }
    }
}

function translateStringsFromJavaScript(name, script) {
    if (performCheck) { log(format('Translating JavaScript of {0} bytes: {1}', script.length, name)); }
    var tokenScript = esprima.tokenize(script, { range: true }), count = 0;
    var output = [], ptr = 0;
    for (var i in tokenScript) {
        var token = tokenScript[i];
        if ((token.type == 'String') && (token.value.length > 2) && (token.value[0] == '"')) {
            var str = token.value.substring(1, token.value.length - 1);
            if (translationTable[str]) {
                output.push(script.substring(ptr, token.range[0]));
                output.push('"' + translationTable[str] + '"');
                ptr = token.range[1];
            }
        }
    }
    output.push(script.substring(ptr));
    return output.join('');
}

function isNumber(x) { return (('' + parseInt(x)) === x) || (('' + parseFloat(x)) === x); }
function format(format) { var args = Array.prototype.slice.call(arguments, 1); return format.replace(/{(\d+)}/g, function (match, number) { return typeof args[number] != 'undefined' ? args[number] : match; }); };



// Check if a list of modules are present and install any missing ones
var InstallModuleChildProcess = null;
var previouslyInstalledModules = {};
function InstallModules(modules, func) {
    var missingModules = [];
    if (previouslyInstalledModules == null) { previouslyInstalledModules = {}; }
    if (modules.length > 0) {
        for (var i in modules) {
            try {
                var xxmodule = require(modules[i]);
            } catch (e) {
                if (previouslyInstalledModules[modules[i]] !== true) { missingModules.push(modules[i]); }
            }
        }
        if (missingModules.length > 0) { InstallModule(missingModules.shift(), InstallModules, modules, func); } else { func(); }
    }
}

// Check if a module is present and install it if missing
function InstallModule(modulename, func, tag1, tag2) {
    log('Installing ' + modulename + '...');
    var child_process = require('child_process');
    var parentpath = __dirname;

    // Get the working directory
    if ((__dirname.endsWith('/node_modules/meshcentral')) || (__dirname.endsWith('\\node_modules\\meshcentral')) || (__dirname.endsWith('/node_modules/meshcentral/')) || (__dirname.endsWith('\\node_modules\\meshcentral\\'))) { parentpath = require('path').join(__dirname, '../..'); }

    // Looks like we need to keep a global reference to the child process object for this to work correctly.
    InstallModuleChildProcess = child_process.exec('npm install --no-optional --save ' + modulename, { maxBuffer: 512000, timeout: 120000, cwd: parentpath }, function (error, stdout, stderr) {
        InstallModuleChildProcess = null;
        if ((error != null) && (error != '')) {
            log('ERROR: Unable to install required module "' + modulename + '". May not have access to npm, or npm may not have suffisent rights to load the new module. Try "npm install ' + modulename + '" to manualy install this module.\r\n');
            process.exit();
            return;
        }
        previouslyInstalledModules[modulename] = true;
        func(tag1, tag2);
        return;
    });
}

// Convert the translations to a standardized JSON we can use in GitHub
// Strings are sorder by english source and object keys are sorted
function translationsToJson(t) {
    var arr2 = [], arr = t.strings;
    for (var i in arr) {
        var names = [], el = arr[i], el2 = {};
        for (var j in el) { names.push(j); }
        names.sort();
        for (var j in names) { el2[names[j]] = el[names[j]]; }
        if (el2.xloc != null) { el2.xloc.sort(); }
        arr2.push(el2);
    }
    arr2.sort(function (a, b) { if (a.en > b.en) return 1; if (a.en < b.en) return -1; return 0; });
    return JSON.stringify({ strings: arr2 }, null, '  ');
}

// Export table
module.exports.startEx = startEx;