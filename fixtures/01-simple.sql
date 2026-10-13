-- 3 tables, 2 relationships: the smallest useful diagram.
CREATE TABLE authors (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    email       text UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE books (
    id          serial PRIMARY KEY,
    author_id   integer NOT NULL REFERENCES authors (id) ON DELETE CASCADE,
    title       text NOT NULL,
    published   date,
    price       numeric(8,2) DEFAULT 0
);

CREATE TABLE reviews (
    id          bigserial PRIMARY KEY,
    book_id     integer NOT NULL,
    rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body        text,
    CONSTRAINT reviews_book_fk FOREIGN KEY (book_id) REFERENCES books (id)
);

CREATE INDEX reviews_book_idx ON reviews (book_id);
