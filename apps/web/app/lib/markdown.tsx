/**
 * Markdown → React elements.
 *
 * The agents answer in markdown — budget tables, headed sections, bullet lists —
 * and the first version of this UI rendered that as preformatted text, so users
 * read literal `**bold**` and pipe-delimited tables. That is the model's output
 * leaking its formatting language.
 *
 * This walks marked's token tree and builds React elements. Nothing goes
 * through `dangerouslySetInnerHTML`, so model output — which is ultimately
 * shaped by whatever a web search returned — can never inject markup.
 */
import { marked, type Token, type Tokens } from 'marked';
import type { ReactNode } from 'react';

/** Renders inline tokens: bold, italic, code, links, line breaks. */
function renderInline(tokens: Token[] | undefined, keyPrefix: string): ReactNode[] {
  if (!tokens) return [];

  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (token.type) {
      case 'strong':
        return <strong key={key}>{renderInline((token as Tokens.Strong).tokens, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline((token as Tokens.Em).tokens, key)}</em>;
      case 'codespan':
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case 'del':
        return <del key={key}>{renderInline((token as Tokens.Del).tokens, key)}</del>;
      case 'br':
        return <br key={key} />;
      case 'link': {
        const link = token as Tokens.Link;
        // Model output can contain arbitrary URLs, so only http(s) is followed
        // and every link opens detached from this page.
        const safe = /^https?:\/\//i.test(link.href) ? link.href : undefined;
        return safe ? (
          <a key={key} href={safe} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(link.tokens, key)}
          </a>
        ) : (
          <span key={key}>{renderInline(link.tokens, key)}</span>
        );
      }
      default:
        return <span key={key}>{(token as { text?: string }).text ?? ''}</span>;
    }
  });
}

function renderBlock(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading;
      // Answers sit inside a card, so headings are demoted: an <h1> from the
      // model must not outrank the page's own heading.
      const Tag = (['h3', 'h3', 'h4', 'h5', 'h6', 'h6'][heading.depth - 1] ?? 'h4') as 'h3';
      return <Tag key={key}>{renderInline(heading.tokens, key)}</Tag>;
    }

    case 'paragraph':
      return <p key={key}>{renderInline((token as Tokens.Paragraph).tokens, key)}</p>;

    case 'list': {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => (
        <li key={`${key}-${index}`}>{renderInline(item.tokens, `${key}-${index}`)}</li>
      ));
      return list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }

    case 'table': {
      const table = token as Tokens.Table;
      return (
        // Budget tables are wide and phones are not, so the table scrolls
        // inside its own box rather than stretching the page.
        <div className="table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={index} style={{ textAlign: table.align[index] ?? 'left' }}>
                    {renderInline(cell.tokens, `${key}-h-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: table.align[cellIndex] ?? 'left' }}>
                      {renderInline(cell.tokens, `${key}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'code':
      return (
        <pre key={key}>
          <code>{(token as Tokens.Code).text}</code>
        </pre>
      );

    case 'blockquote':
      return (
        <blockquote key={key}>
          {(token as Tokens.Blockquote).tokens.map((child, index) =>
            renderBlock(child, `${key}-${index}`),
          )}
        </blockquote>
      );

    case 'hr':
      return <hr key={key} />;

    case 'space':
      return null;

    default: {
      const text = (token as { text?: string }).text;
      return text ? <p key={key}>{text}</p> : null;
    }
  }
}

export function Markdown({ children }: { children: string }) {
  // Newlines are meaningful in chat output, and a lexing failure must degrade to
  // plain text rather than blanking an answer the user is waiting on.
  let tokens: Token[];
  try {
    tokens = marked.lexer(children, { gfm: true, breaks: true });
  } catch {
    return <p>{children}</p>;
  }

  return <div className="md">{tokens.map((token, index) => renderBlock(token, `b-${index}`))}</div>;
}
