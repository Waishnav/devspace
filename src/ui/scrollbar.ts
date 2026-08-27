export const pierrePrettyScrollbarCss = `
:host {
  --diffs-scrollbar-gutter-override: 12px;
}

[data-code] {
  scrollbar-gutter: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb, rgb(128 128 128 / 55%)) transparent;
}

@supports selector(::-webkit-scrollbar) {
  [data-code]::-webkit-scrollbar {
    width: 12px;
    height: 12px;
  }

  [data-code]::-webkit-scrollbar-button {
    display: none;
    width: 0;
    height: 0;
  }

  [data-code]::-webkit-scrollbar-track {
    background: transparent;
  }

  [data-code]::-webkit-scrollbar-thumb {
    background-color: var(--scrollbar-thumb, rgb(128 128 128 / 55%));
    background-clip: content-box;
    border: 4px solid transparent;
    border-radius: 9999px;
  }

  [data-code]::-webkit-scrollbar-thumb:hover,
  [data-code]::-webkit-scrollbar-thumb:active {
    background-color: var(--scrollbar-thumb-hover, rgb(112 112 112 / 85%));
  }

  [data-code]::-webkit-scrollbar-corner {
    background: transparent;
  }
}
`;
