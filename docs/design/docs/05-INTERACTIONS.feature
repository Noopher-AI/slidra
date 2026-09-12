# 05 · Frontend Interaction Patterns (BDD / Gherkin)
# language: en

Feature: Stage navigation (Figma-style)
  Background:
    Given I am in edit mode with a slide shown on the stage

  Scenario: Zoom with the wheel
    When I hold ⌘ (or Ctrl) and scroll the mouse wheel
    Then the slide zooms centered on the cursor, within 25%–400%
    And the percentage on the left of the toolbar updates live

  Scenario: Pan with the wheel
    When I scroll without holding a modifier key (including two-finger scroll)
    Then the slide pans accordingly

  Scenario: Grab mode
    When I press the ✋ button in the toolbar
    Then the current selection is cleared and the cursor becomes a hand
    And dragging on the slide, an element, or empty space all pan the canvas
    When I press ✋ again
    Then it returns to edit mode

  Scenario: Temporary grab
    When I hold Space
    Then it behaves like grab mode; releasing Space restores the previous mode

  Scenario: Zoom menu
    When I click the percentage in the toolbar
    Then a horizontal menu grows from directly above and centered on the toolbar: − percentage + ｜ Fit 50% 75% 100% 150% 200% 400%
    And the current value is shown in red
    When I choose Fit
    Then the zoom returns to 100% and centers

Feature: Selection
  Scenario: Single selection
    When I click one element
    Then a red selection box appears with four corner handles and a name label at the top-left
    And the contextual bar appears directly below the selection box (or flips above if there isn't room)

  Scenario: Multi-selection
    When I ⇧+click another element, or drag a marquee over empty space
    Then all hit elements are enclosed in a dashed group box, draggable as a whole, with no resize handles

  Scenario: Select all / deselect
    When I press ⌘A
    Then all elements on the current page are selected
    When I press Esc or click empty space
    Then the selection is cleared and all overlays close

Feature: Moving and resizing elements
  Scenario: Drag with snapping
    Given I am dragging a selected element
    Then it snaps when near canvas edges/centerlines or other elements' edges/centers, showing pink guide lines
    And holding ⌥ disables snapping
    When I release the mouse
    Then this move becomes one undoable history entry

  Scenario: Resize
    When I drag a corner handle
    Then the element resizes in that handle's direction, with a minimum of 3cqw × 0.6cqh, staying within the slide bounds

Feature: In-place editing
  Scenario: Text
    When I double-click text (or press Enter after selecting it)
    Then the text becomes an input; on double-click the cursor lands at the click point, on Enter the cursor lands at the end of the text
    When I press Enter inside the input
    Then a hard line break is inserted at the cursor, without committing or leaving edit mode
    When I press ⌘Enter or Ctrl+Enter inside the input
    Then no line break is inserted, and it does not commit or leave edit mode
    When I press Esc or the input loses focus
    Then edit mode ends and the change is committed

  Scenario: Table cell
    When I click a cell
    Then that cell is selected (⇧+click extends the range), and the right rail's Style › Object shows the Cell section
    When I double-click a cell
    Then it enters edit mode; Tab moves to the next cell
    When I right-click a cell
    Then a menu appears: Edit / Bold / insert row·column / merge or unmerge / delete row·column

  Scenario: Column width
    When I drag a column border in the table's first row
    Then that column's width changes live, and the change enters history on release

Feature: Bottom glass toolbar
  Scenario: Insert (all types ask for input first)
    When I click Text / Image / Video / Audio / Table / Chart
    Then the corresponding panel grows from directly above and centered on the toolbar
    And Text: an input + style presets + alignment, Enter inserts directly
    And Image/Video/Audio: drag-and-drop or file picker, URL, caption; inserts a placeholder if left empty
    And Table: an 8×6 grid with hover preview and click-to-lock size; theme; header
    And Chart: type, number of series, number of categories, palette
    When I click Insert
    Then the element is added to the current page and selected; the panel closes

  Scenario: Shape / Arrange menus
    When I click Shape
    Then a horizontal menu grows: Rectangle / Ellipse / Line
    When I click Arrange
    Then a three-column menu grows: Align / Distribute / Order; items are disabled with no selection; Distribute requires ≥3 elements

  Scenario: Disabled state
    Given nothing is selected
    Then Animate / Arrange are semi-transparent and unclickable; Group is also unclickable (requires ≥2 elements or a whole group)

Feature: Groups (including nesting)
  Scenario: Grouping
    Given I have 2 or more elements selected
    When I click Group
    Then they become a group, and any existing per-object animation on the members is removed (shown as a toast)
  Scenario: Selecting a group
    When I click any member of a group
    Then the whole group is selected (solid outline), with the label showing the group's name
  Scenario: Drilling in
    When I double-click a member of an already-selected group
    Then the selection narrows to the next layer (a subgroup or that element), with the label showing the path "Group 2 › Group 1"
  Scenario: Nesting
    Given the selection includes an existing group plus other elements
    When I click Group
    Then an outer group wraps around them
  Scenario: Ungrouping
    Given a whole group is selected
    When I click Ungroup
    Then only the currently drilled-into layer is dissolved, and that group's animation is removed

Feature: Object animation (PPTX mental model)
  Scenario: Adding an animation
    Given something is selected
    When I click Animate in the toolbar
    Then a panel grows: effect cards (looping preview), Start (On click / With / After), Duration
    When I click Add animation
    Then the animation is added to the selected element(s); the right rail switches to Animate › Object; the card is appended to the end of the list
  Scenario: Group animation
    Given a whole group is selected and an animation is added
    Then the members share the effect; the first carries the trigger timing, the rest use "With previous"; the list shows a single "Group N (n)" card
  Scenario: Reordering and parameters
    When I click ↑↓ on a card
    Then the click order changes; the number badges on the stage update accordingly
    When I change the effect / Start / Duration / Delay
    Then it applies immediately and enters history
  Scenario: Preview
    When I click Preview
    Then the whole page's animation plays in sequence; a single card's ▶ plays only that segment

Feature: Page animation
  Scenario: Configuring
    When I choose an Enter/Exit effect and duration in Animate › Page
    Then Enter plays when entering that page during playback, and Exit plays before switching away from it
    When I click Apply to all slides
    Then the same settings apply to every page

Feature: Playback
  Scenario: Advancing
    Given I am in play mode
    When I press → / Space / click the screen
    Then it reveals the next animation step if one remains, otherwise advances to the next page
  Scenario: Exiting
    When I press Esc or Exit
    Then it returns to edit mode

Feature: Collaborating with AI
  Scenario: Commenting on an element
    Given an element is selected
    When I click Comment to AI in the contextual bar
    Then a glass comment box grows from the selection box; ⌘↵ or Add comment saves it
    Then a red pin number appears next to the selection label; the chat panel's Pinned context gains a row (page number + truncated comment)
  Scenario: Commenting on a whole page
    When I click the comment button at the top-right of a thumbnail
    Then the same happens, targeting the whole page
  Scenario: Jumping and editing
    When I click a row in Pinned context, or a pin number on the stage
    Then it jumps to that page, selects that element, and opens the comment box showing the original text; it can be edited or deleted
  Scenario: Sending
    When I send a message
    Then the message, along with all pins, is sent to the agent as context (the input shows "n pinned")
  Scenario: Agent is editing
    Given a lock event is received
    Then the title bar shows "Agent editing · undo paused", and Undo/Redo are disabled

Feature: Page management
  Scenario: New / Templates
    When I click New in the left rail
    Then a layout list expands (Blank + templates + From outline…)
  Scenario: Generating from an outline
    When I paste an outline and click Draft with agent
    Then a Running command card appears; after 1.4s a new page is inserted after the current page (indentation becomes subtitles)
  Scenario: Drag to reorder
    When I drag a thumbnail to another position
    Then a red insertion line indicates the drop point; releasing reorders it and enters history

Feature: History
  Scenario: Undo / Redo
    When I press ⌘Z / ⇧⌘Z or the title-bar buttons
    Then it undoes/redoes the last structural change (move, resize, text, table, chart, reorder, add/delete, animation, group — page size is not included)
