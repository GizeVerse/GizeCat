// Minimal, strict JSON reader for the request lines and a writer for the responses.
// Numbers are always formatted with the invariant culture (the host may run e.g. a Turkish locale).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DesktopCat.Uia
{
    internal sealed class JsonReader
    {
        private const int MaxDepth = 8;
        private const int MaxItems = 64;
        private const int MaxStringChars = 256;

        private readonly string text;
        private int pos;
        private int depth;

        private JsonReader(string text)
        {
            this.text = text;
        }

        /// <summary>Parses a complete document; throws FormatException on any deviation.</summary>
        internal static object Parse(string text)
        {
            var reader = new JsonReader(text);
            reader.SkipWhitespace();
            object value = reader.ReadValue();
            reader.SkipWhitespace();
            if (reader.pos != text.Length) throw new FormatException("trailing data");
            return value;
        }

        private char Peek()
        {
            if (pos >= text.Length) throw new FormatException("unexpected end");
            return text[pos];
        }

        private void SkipWhitespace()
        {
            while (pos < text.Length && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\r' || text[pos] == '\n')) pos++;
        }

        private object ReadValue()
        {
            if (++depth > MaxDepth) throw new FormatException("too deep");
            try
            {
                char c = Peek();
                switch (c)
                {
                    case '{': return ReadObject();
                    case '[': return ReadArray();
                    case '"': return ReadString();
                    case 't': ReadLiteral("true"); return true;
                    case 'f': ReadLiteral("false"); return false;
                    case 'n': ReadLiteral("null"); return null;
                    default: return ReadNumber();
                }
            }
            finally
            {
                depth--;
            }
        }

        private void ReadLiteral(string literal)
        {
            if (string.CompareOrdinal(text, pos, literal, 0, literal.Length) != 0) throw new FormatException("bad literal");
            pos += literal.Length;
        }

        private Dictionary<string, object> ReadObject()
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            pos++;
            SkipWhitespace();
            if (Peek() == '}')
            {
                pos++;
                return result;
            }
            while (true)
            {
                SkipWhitespace();
                if (Peek() != '"') throw new FormatException("expected key");
                string key = ReadString();
                SkipWhitespace();
                if (Peek() != ':') throw new FormatException("expected colon");
                pos++;
                SkipWhitespace();
                if (result.ContainsKey(key)) throw new FormatException("duplicate key");
                if (result.Count >= MaxItems) throw new FormatException("too many keys");
                result[key] = ReadValue();
                SkipWhitespace();
                char c = Peek();
                pos++;
                if (c == '}') return result;
                if (c != ',') throw new FormatException("expected comma");
            }
        }

        private List<object> ReadArray()
        {
            var result = new List<object>();
            pos++;
            SkipWhitespace();
            if (Peek() == ']')
            {
                pos++;
                return result;
            }
            while (true)
            {
                SkipWhitespace();
                if (result.Count >= MaxItems) throw new FormatException("too many items");
                result.Add(ReadValue());
                SkipWhitespace();
                char c = Peek();
                pos++;
                if (c == ']') return result;
                if (c != ',') throw new FormatException("expected comma");
            }
        }

        private string ReadString()
        {
            pos++;
            var sb = new StringBuilder();
            while (true)
            {
                char c = Peek();
                pos++;
                if (c == '"') return sb.ToString();
                if (c < 0x20) throw new FormatException("control character");
                if (c == '\\')
                {
                    char e = Peek();
                    pos++;
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (pos + 4 > text.Length) throw new FormatException("bad escape");
                            int code;
                            if (!int.TryParse(text.Substring(pos, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw new FormatException("bad escape");
                            sb.Append((char)code);
                            pos += 4;
                            break;
                        default: throw new FormatException("bad escape");
                    }
                }
                else
                {
                    sb.Append(c);
                }
                if (sb.Length > MaxStringChars) throw new FormatException("string too long");
            }
        }

        private double ReadNumber()
        {
            int start = pos;
            while (pos < text.Length)
            {
                char c = text[pos];
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') pos++;
                else break;
            }
            if (pos == start) throw new FormatException("unexpected character");
            double value;
            if (!double.TryParse(text.Substring(start, pos - start), NumberStyles.Float, CultureInfo.InvariantCulture, out value)) throw new FormatException("bad number");
            if (double.IsNaN(value) || double.IsInfinity(value)) throw new FormatException("bad number");
            return value;
        }
    }

    /// <summary>Appends compact JSON. Only ASCII keys and protocol-defined string values are written.</summary>
    internal sealed class JsonWriter
    {
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        private readonly StringBuilder sb = new StringBuilder(256);
        private bool needComma;

        internal JsonWriter BeginObject()
        {
            Separator();
            sb.Append('{');
            needComma = false;
            return this;
        }

        internal JsonWriter EndObject()
        {
            sb.Append('}');
            needComma = true;
            return this;
        }

        internal JsonWriter BeginArray()
        {
            Separator();
            sb.Append('[');
            needComma = false;
            return this;
        }

        internal JsonWriter EndArray()
        {
            sb.Append(']');
            needComma = true;
            return this;
        }

        internal JsonWriter Key(string key)
        {
            Separator();
            AppendString(key);
            sb.Append(':');
            needComma = false;
            return this;
        }

        internal JsonWriter Value(string value)
        {
            Separator();
            if (value == null) sb.Append("null");
            else AppendString(value);
            needComma = true;
            return this;
        }

        internal JsonWriter Value(long value)
        {
            Separator();
            sb.Append(value.ToString(Inv));
            needComma = true;
            return this;
        }

        internal JsonWriter Value(bool value)
        {
            Separator();
            sb.Append(value ? "true" : "false");
            needComma = true;
            return this;
        }

        internal JsonWriter Value(double value)
        {
            Separator();
            if (double.IsNaN(value) || double.IsInfinity(value)) sb.Append("null");
            else sb.Append(value.ToString("0.###", Inv));
            needComma = true;
            return this;
        }

        internal JsonWriter Null()
        {
            Separator();
            sb.Append("null");
            needComma = true;
            return this;
        }

        internal JsonWriter Id(long? id)
        {
            Key("id");
            if (id.HasValue) Value(id.Value);
            else Null();
            return this;
        }

        public override string ToString()
        {
            return sb.ToString();
        }

        private void Separator()
        {
            if (needComma) sb.Append(',');
        }

        private void AppendString(string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) sb.AppendFormat(Inv, "\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            sb.Append('"');
        }
    }
}
