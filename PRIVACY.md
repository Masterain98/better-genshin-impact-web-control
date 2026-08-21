# Privacy Policy for BetterGI Web Cloud Bridge

**Effective date: August 21, 2026**

BetterGI Web Cloud Bridge is a browser extension that connects BetterGI with the web version of Cloud Genshin Impact.

This privacy policy explains what data the extension processes and how that data is used.

## Data We Process

BetterGI Web Cloud Bridge processes only the data required to provide its browser bridge functionality.

### Website Content

When the user explicitly connects a Cloud Genshin Impact tab, the extension captures the visual content of that tab.

The captured game view is cropped, resized, and encoded before being sent to the BetterGI bridge endpoint configured by the user.

The extension does not permanently store captured game frames.

### Bridge Authentication Token

Users may optionally configure a connection token for authenticating with the BetterGI bridge service.

The token is stored locally using Chrome's extension storage and is transmitted only to the configured BetterGI bridge endpoint as part of the bridge connection.

This token is unrelated to the user's HoYoverse or Cloud Genshin Impact account credentials.

### Extension Configuration

The extension stores configuration such as the bridge host and port, image settings, frame rate, logical resolution, and input-related settings using `chrome.storage.local`.

This information is used only to provide and configure the extension's functionality.

### Diagnostic Information

The extension may temporarily maintain diagnostic information such as connection state, frame statistics, viewport information, session identifiers, and error messages.

Diagnostic information is not automatically transmitted to the developer. Users may explicitly export diagnostic information themselves for troubleshooting.

## How Data Is Used

Data processed by the extension is used exclusively to:

* transmit the Cloud Genshin Impact game view to BetterGI;
* forward BetterGI keyboard and mouse input to the connected game tab;
* maintain and monitor the bridge session;
* calculate the game viewport and input coordinates; and
* provide configuration and diagnostic functionality.

The extension does not use user data for advertising, analytics, profiling, credit scoring, or unrelated purposes.

## Data Sharing

BetterGI Web Cloud Bridge does not sell user data.

The extension does not send captured content, authentication information, or usage information to the extension developer or to advertising or analytics services.

Game frames and the optional bridge token are transmitted only to the BetterGI bridge endpoint configured by the user as necessary to provide the extension's core functionality.

## Data Retention

Captured game frames are processed in memory and are not persistently stored by the extension.

Extension configuration, including an optional bridge token, remains in Chrome's local extension storage until the user changes the configuration, resets it, or removes the extension.

Temporary diagnostic information is maintained only as necessary for the current extension runtime and troubleshooting.

## Data We Do Not Collect

BetterGI Web Cloud Bridge does not collect:

* personally identifiable information;
* health information;
* financial or payment information;
* personal communications;
* location information;
* browsing history;
* HoYoverse account passwords or cookies; or
* user activity for advertising or tracking purposes.

## Third-Party Services

The extension does not include advertising, analytics, tracking SDKs, or other third-party data collection services.

The BetterGI bridge endpoint is selected or configured by the user and is used solely to provide the bridge functionality requested by the user.

## Changes to This Policy

This privacy policy may be updated if the extension's functionality or data handling practices change. Any material changes will be reflected in the current version of this document.

## Contact

Questions or concerns regarding this privacy policy may be submitted through the public GitHub issue tracker for the BetterGI Web Cloud Bridge project.
