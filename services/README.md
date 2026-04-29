# Shakespeare Services

This directory contains additional microservices that can be optionally deployed alongside Shakespeare to host a complete Shakespeare instance.

## Preview Iframe Service

Shakespeare uses [iframe.diy](https://iframe.diy/) to sandbox project previews on an isolated origin, protecting the main app's `localStorage` and `IndexedDB` from untrusted preview code. The default `previewDomain` in the app config is `iframe.diy`.

To self-host the iframe preview service, deploy [soapbox-pub/iframe.diy](https://gitlab.com/soapbox-pub/iframe.diy) on your own domain and set `previewDomain` accordingly.
