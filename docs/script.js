// No reveal-on-scroll gating here. The previous version hid every section
// behind opacity:0 and only revealed them when IntersectionObserver fired,
// which made anything below the fold invisible until a visitor scrolled.
// That "off-error" made the page look broken in full-page captures. Content
// is visible on arrival; animation, if any, should never gate legibility.
