# Mobile Layout Audit - Small Viewports

**Audit Date:** 2026-03-23
**Target Viewports:** 320px (iPhone SE), 360px (Galaxy A-series), 375px (iPhone 13 mini)
**Acceptance Criteria:** All elements fit on screen without scrolling, touch targets ≥44px, readable fonts without zoom, thumb-friendly navigation

---

## Executive Summary

This audit identifies mobile responsiveness issues on small screens (320px-375px width). Key findings include:
- **Critical:** Touch targets below accessibility minimum (44px) on keyboard keys
- **High:** Excessive padding reducing usable content area
- **High:** Header complexity causing excessive vertical space usage
- **Medium:** Horizontal overflow on leaderboard tables
- **Medium:** Font sizes requiring adjustment for optimal readability

---

## Viewport-Specific Issues

### 320px Width (Smallest Target - iPhone SE)

#### Layout Issues

**Header (topbar)**
- **Issue:** Header wraps into 3+ rows due to multiple flex containers
  - Row 1: Title + subtitle
  - Row 2: Navigation links ("Create", "Daily Word")
  - Row 3-4: Settings toggles wrap across multiple lines
- **Impact:** Header consumes ~180-220px vertical space, reducing game area
- **Recommendation:** Stack vertically, use hamburger menu, or reduce header elements

**Panel Padding**
- **Issue:** Panel uses `padding: 2rem` (32px) on all sides
  - Total horizontal padding: 64px (20% of viewport)
  - Usable content width: Only 256px on 320px screen
- **Impact:** Content feels cramped despite excessive whitespace
- **Recommendation:** Reduce to `padding: 1rem` (16px) for viewports <400px

**Main Panel Width**
- **Current:** `width: min(56rem, 95vw)` = 304px on 320px screen
- **Issue:** With 2rem padding, only 240px usable width for content
- **Recommendation:** Use 98vw on small screens to maximize space

#### Game Board

**Board Container**
- **Current:** `width: min(95vw, calc(var(--cols) * 4.2rem))`
  - On 320px: 304px for 5 columns
  - Per tile + gap: ~60px available
- **Issue:** Tiles render at ~54px with 0.65rem (10.4px) gaps
  - Calculation: (304px - 4×10.4px) / 5 = 54.4px per tile
- **Status:** ✅ Fits within viewport (no overflow)
- **Note:** Tiles scale down appropriately

**Tile Font Size**
- **Current:** `font-size: 1.6rem` (25.6px at default browser settings)
- **Issue:** Font might appear large relative to tile size on smallest screens
- **Recommendation:** Consider scaling to 1.4rem for viewports <360px

**Gap Spacing**
- **Current:** `gap: 0.65rem` (10.4px)
- **Status:** ✅ Adequate spacing maintained
- **Recommendation:** Could reduce to 0.5rem (8px) to gain more tile space

#### Virtual Keyboard

**Keyboard Touch Targets - CRITICAL**
- **Current:** Keys use `min-height: clamp(2.4rem, 7vw, 3.2rem)`
  - At 320px: `7vw = 22.4px` → clamped to `2.4rem = 38.4px`
  - **FAILS** WCAG 2.5.5 minimum touch target (44px)
- **Impact:** High mispress rate, accessibility violation
- **Recommendation:** Change to `clamp(44px, 7vw, 3.2rem)` or `min-height: 44px`

**Key Width**
- **Current:** Keys use `flex: 1` with `min-width: 2rem` (32px)
- **Calculation at 320px:**
  - Keyboard width: min(40rem, 95vw) = 304px
  - Top row: 10 keys with 9 gaps (0.4rem each)
  - Available: 304px - 9×6.4px = 246.4px
  - Per key: 246.4px / 10 = ~24.6px width
- **Issue:** Keys are ~24.6px × 38.4px = **BELOW 44×44px minimum**
- **Recommendation:** Reduce gap to 0.3rem, increase min-height to 44px

**Keyboard Width**
- **Current:** `width: min(40rem, 95vw)` = 304px
- **Status:** ✅ Fits within viewport
- **Recommendation:** Use 98vw for consistency with board

#### Form Elements

**Input Fields**
- **Current:** `padding: 0.6rem 0.8rem` with `font-size: 1rem`
- **Status:** ✅ Adequate touch target height (~40px)
- **Note:** Consider increasing to 44px minimum

**Buttons**
- **Current:** Primary buttons use `padding: 0.75rem 1rem`
- **Status:** ✅ Adequate touch target (~48px height)
- **Note:** Width varies based on text content

**Select Dropdowns**
- **Current:** Theme select uses `padding: 0.2rem 0.5rem`
- **Issue:** Very small touch target (~28px height)
- **Recommendation:** Increase to `padding: 0.5rem 0.75rem` for 44px minimum

#### Navigation & Links

**Admin Links**
- **Current:** `padding: 0.6rem 1.2rem` = ~38px height
- **Issue:** Slightly below 44px minimum
- **Recommendation:** Increase to `padding: 0.75rem 1.2rem`

**Link Buttons**
- **Current:** `padding: 0.45rem 0.9rem` = ~36px height
- **Issue:** Below 44px minimum
- **Recommendation:** Increase to `padding: 0.65rem 0.9rem`

#### Typography

**H1 Title**
- **Current:** `font-size: 2rem` (32px)
- **Issue:** Very large on 320px screen (10% of viewport width)
- **Recommendation:** Scale to `font-size: 1.5rem` for viewports <400px

**Body Text**
- **Current:** Base font size relies on browser default (16px)
- **Status:** ✅ Meets minimum readable size (no zoom required)

**Hint Text**
- **Current:** `font-size: 0.85rem` (13.6px)
- **Status:** ✅ Acceptable for supplementary text
- **Note:** Monitor for readability on low-DPI screens

#### Leaderboard

**Table Container**
- **Current:** `min-width: 32rem` (512px) with `overflow-x: auto`
- **Issue:** **HORIZONTAL SCROLL REQUIRED** (512px > 320px)
- **Impact:** Poor mobile UX, violates "no scrolling" requirement
- **Recommendation:**
  - Remove min-width for mobile
  - Stack columns vertically or use cards
  - Hide less critical columns (e.g., "Played" column)

**Table Font Size**
- **Current:** `font-size: 0.9rem` (14.4px)
- **Status:** ✅ Readable
- **Note:** May be tight with 7 columns on small screens

#### Modal

**Modal Card**
- **Current:** `width: min(32rem, 92vw)` = 294px on 320px
- **Status:** ✅ Fits within viewport
- **Padding:** `padding: 1.5rem` (24px) leaves 246px for content
- **Recommendation:** Reduce to `padding: 1rem` on small screens

#### Footer

**Footer Layout**
- **Current:** `flex-wrap: wrap` with `gap: 0.75rem`
- **Media Query:** Already stacks to column at <720px
- **Status:** ✅ Handles small screens appropriately

---

### 360px Width (Galaxy A-series)

#### Improvements Over 320px

- **Keyboard:** `7vw = 25.2px` → still clamped to 38.4px (still FAILS 44px minimum)
- **Panel:** More breathing room with ~296px usable width after padding
- **Touch targets:** Marginally better but still below 44px in many places

#### Remaining Issues

- **Keyboard touch targets:** Still below 44px minimum (critical)
- **Header wrapping:** Still 3-4 rows (high impact)
- **Select dropdowns:** Still undersized (~28px)
- **Leaderboard:** Still requires horizontal scroll

---

### 375px Width (iPhone 13 mini, iPhone SE 2022)

#### Improvements

- **Keyboard:** `7vw = 26.25px` → still clamped to 38.4px (FAILS 44px minimum)
- **Panel:** ~311px usable width provides better spacing
- **More common viewport:** Many optimizations here benefit broader audience

#### Remaining Issues

- **Keyboard touch targets:** CRITICAL - still below 44px
- **Header complexity:** Still inefficient vertical space usage
- **Leaderboard:** Still requires horizontal scroll
- **Some touch targets:** Admin links, link buttons still undersized

---

## Element Overflow Analysis

### Elements That Overflow (Horizontal Scroll)

1. **Leaderboard Table**
   - Min-width: 512px
   - Viewports affected: 320px, 360px, 375px
   - Severity: **HIGH**

### Elements That Fit But Are Cramped

1. **Game Board** - Fits but tiles are small (~54px on 320px)
2. **Keyboard** - Fits but keys are undersized for touch
3. **Panel Content** - Fits but excessive padding reduces usable space

### Elements That May Clip

1. **Long player names** in leaderboard (truncation needed)
2. **Share links** if very long (already has text wrapping)

---

## Touch Target Summary

### Elements Below 44×44px Minimum ❌

| Element | Current Size | Target Size | Priority |
|---------|--------------|-------------|----------|
| Keyboard keys | ~25×38px @ 320px | 44×44px | **CRITICAL** |
| Select dropdowns | ~40×28px | 44×44px | **HIGH** |
| Admin links | ~40×38px | 44×44px | **MEDIUM** |
| Link buttons | ~36×36px | 44×44px | **MEDIUM** |
| Toggle checkboxes | 16×16px | 24×24px min | **LOW** |

### Elements Meeting 44×44px ✅

- Primary submit buttons (~48px)
- Ghost buttons (~44px)
- Text input fields (~40px, acceptable for text entry)

---

## Font Size Analysis

### Elements Requiring Zoom (< 16px)

None identified - all critical text meets minimum size ✅

### Elements That May Benefit From Scaling

| Element | Current Size | Issue | Recommendation |
|---------|--------------|-------|----------------|
| H1 title | 32px | Too large on small screens | Scale to 24px @ <400px |
| Tile font | 25.6px | Tight relative to tile size | Scale to 22.4px @ <360px |
| Hint text | 13.6px | Borderline for low-DPI | Monitor, consider 14px minimum |

---

## Navigation Issues

### Header Navigation

**Current State:**
- Three separate flex containers that wrap independently
- Creates 3-4 rows on small screens
- "Create" and "Daily Word" links in top-right that wrap below

**Issues:**
- Takes up excessive vertical space (180-220px)
- Pushes game content below fold
- Settings toggles scattered across multiple rows

**Recommendations:**
1. **Hamburger menu** for navigation + settings on mobile
2. **Sticky header** with collapsed state
3. **Bottom navigation bar** for key actions (Create, Daily, Settings)
4. **Reduce header elements** - move some to footer or menu

### Thumb-Friendly Zones

**Optimal thumb reach zones on phones:**
- Bottom 1/3 of screen: Easiest to reach
- Middle 1/3: Reachable but requires stretch
- Top 1/3: Difficult, requires hand repositioning

**Current Layout Issues:**
- Navigation links in header (top 1/3) - hard to reach
- Keyboard at bottom (good placement ✅)
- Primary actions scattered

**Recommendations:**
- Move primary actions to bottom (floating action button or bottom nav)
- Consider bottom sheet for settings instead of top header
- Keep keyboard at bottom (already optimal)

---

## Landscape Orientation

**Status:** Not explicitly handled

**Potential Issues:**
- Vertical space very limited in landscape
- Keyboard + board may require scrolling
- Header consumes even more relative vertical space

**Recommendations:**
1. Add `@media (orientation: landscape)` queries
2. Collapse header to single row
3. Consider side-by-side board + keyboard layout
4. Reduce vertical padding in landscape mode

---

## Critical Path Issues

### Game Creation Flow

1. **Language select** - ✅ Adequate size
2. **Word input** - ✅ Adequate size
3. **Length/Guesses inputs** - ✅ Adequate size
4. **Submit button** - ✅ Adequate size

**Status:** Form elements meet minimum sizes ✅

### Gameplay Flow

1. **View board** - ✅ Fits on screen
2. **Tap keyboard keys** - ❌ **CRITICAL ISSUE** - Keys too small
3. **View feedback** - ✅ Message area visible
4. **Share results** - ✅ Share link field adequate

**Blocker:** Keyboard keys below minimum touch target size

### Player Profile Flow

1. **Switch player button** - ⚠️ Borderline size
2. **Name input** - ✅ Adequate
3. **Submit button** - ✅ Adequate
4. **Player chips** - ⚠️ May be undersized

**Status:** Mostly functional but could be improved

---

## Recommendations Summary

### Priority 1 (Critical - Blocks Accessibility)

1. **Fix keyboard touch targets**
   - Change `min-height: clamp(2.4rem, 7vw, 3.2rem)` to `clamp(44px, 8vw, 3.2rem)`
   - Ensure keys meet 44×44px minimum on all viewports
   - Test on actual devices to verify

### Priority 2 (High - Usability Issues)

2. **Reduce panel padding on small screens**
   ```css
   @media (max-width: 400px) {
     .panel { padding: 1rem; }
   }
   ```

3. **Fix leaderboard horizontal scroll**
   - Stack columns vertically as cards on mobile
   - Or hide non-essential columns
   - Remove `min-width: 32rem` for mobile

4. **Optimize header for mobile**
   - Implement hamburger menu or bottom navigation
   - Reduce to single row on small screens
   - Move settings to dedicated modal

### Priority 3 (Medium - Polish)

5. **Increase touch targets for links**
   - Admin links: increase to 44px height
   - Link buttons: increase to 44px height
   - Select dropdowns: increase to 44px height

6. **Scale typography for small screens**
   ```css
   @media (max-width: 400px) {
     h1 { font-size: 1.5rem; }
     .tile { font-size: 1.4rem; }
   }
   ```

7. **Add landscape orientation support**
   - Collapse header in landscape
   - Optimize vertical spacing
   - Consider horizontal layout

### Priority 4 (Low - Nice to Have)

8. **Reduce board gaps on smallest screens**
   - Change from 0.65rem to 0.5rem for more tile space

9. **Optimize modal padding**
   - Reduce to 1rem on small screens

10. **Add safe area insets for notched devices**
    - Already has `padding-bottom: env(safe-area-inset-bottom)` ✅
    - Add `padding-left: env(safe-area-inset-left)` for landscape

---

## Testing Checklist

### Manual Testing Required

- [ ] Test keyboard on actual 320px device (iPhone SE 1st gen if available)
- [ ] Verify touch targets with actual thumb usage
- [ ] Test landscape orientation on phone
- [ ] Test with iOS Safari and Chrome mobile
- [ ] Test with Android Chrome and Samsung Internet
- [ ] Verify font readability on low-DPI device
- [ ] Test leaderboard scroll behavior
- [ ] Test modal interactions on small screen
- [ ] Verify header wrapping behavior
- [ ] Test with large text accessibility setting

### Automated Testing (Playwright)

- [ ] Update `tests/ui/mobile.spec.js` to test 320px viewport
- [ ] Add touch target size assertions
- [ ] Add horizontal overflow detection
- [ ] Add landscape orientation tests
- [ ] Add font size verification tests

---

## Comparison to React-Wordle Issues

**Known Issues in React-Wordle:**
- iPhone SE requires scrolling (our app: SAME ISSUE due to header size)
- Keyboard too small on tiny screens (our app: SAME ISSUE - below 44px)
- Layout breaks in landscape (our app: NOT HANDLED)

**Our Advantages:**
- Simpler header (but still too large)
- Better base CSS structure
- Already using modern CSS (dvh, clamp)

**Our Gaps:**
- Touch targets still too small
- Leaderboard horizontal scroll
- Header still consumes too much space

---

## Next Steps

1. **Implement Priority 1 fixes** (keyboard touch targets)
2. **Test on real devices** at 320px, 360px, 375px
3. **Implement Priority 2 fixes** (padding, leaderboard, header)
4. **Add automated tests** for mobile viewports
5. **Implement landscape support**
6. **Final accessibility audit** with WAVE or axe DevTools

---

## Appendix: CSS Breakpoint Recommendations

```css
/* Current: Only one breakpoint */
@media (max-width: 720px) { /* tablet/desktop breakpoint */ }

/* Recommended: Multiple mobile breakpoints */
@media (max-width: 400px) { /* Small phones - iPhone SE, older Android */ }
@media (max-width: 640px) { /* Standard phones */ }
@media (max-width: 768px) { /* Tablets */ }
@media (orientation: landscape) and (max-height: 500px) { /* Landscape phones */ }
```

---

**Audit Completed:** 2026-03-23
**Auditor:** Claude Code (Mobile UX Analysis)
**Next Review:** After implementing Priority 1-2 fixes
