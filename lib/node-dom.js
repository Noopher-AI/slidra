// A strict DOMParser/XMLSerializer pair for running the viewer's slide code
// under Node (tools and tests), built on @xmldom/xmldom. Like a browser's
// XML parser, it refuses a document that is not well-formed instead of
// guessing: an error while parsing yields a <parsererror> document.

import { DOMParser as XmldomParser, XMLSerializer } from "@xmldom/xmldom";

class StrictDOMParser {
  parseFromString(source, type) {
    let failed = null;
    const parser = new XmldomParser({
      onError: (level, message) => {
        if (level !== "warning" && failed === null) failed = message;
      },
    });
    let doc;
    try {
      doc = parser.parseFromString(source, type);
    } catch (error) {
      failed = failed ?? error.message;
    }
    if (failed !== null || !doc) {
      return new XmldomParser().parseFromString(`<parsererror xmlns="http://www.w3.org/1999/xhtml">${escape(String(failed))}</parsererror>`, "application/xml");
    }
    return doc;
  }
}

const escape = (text) => text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);

/** @type {{ DOMParser: any, XMLSerializer: any }} */
export const nodeDom = { DOMParser: StrictDOMParser, XMLSerializer };
