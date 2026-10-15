-----------------------------------------------------------------------------------------------
--  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
--  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
-----------------------------------------------------------------------------------------------

-- Seed for the MySQL lab container (runs once, via /docker-entrypoint-initdb.d).
USE lab;

CREATE TABLE customers (
	id INT AUTO_INCREMENT PRIMARY KEY,
	email VARCHAR(255) NOT NULL UNIQUE,
	name VARCHAR(120) NOT NULL,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
	id INT AUTO_INCREMENT PRIMARY KEY,
	customer_id INT NOT NULL,
	total DECIMAL(10,2) NOT NULL DEFAULT 0,
	status VARCHAR(20) NOT NULL DEFAULT 'pending',
	CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE INDEX idx_orders_status ON orders(status);

INSERT INTO customers (email, name) VALUES
	('ann@example.com', 'Ann'),
	('bob@example.com', 'Bob');

INSERT INTO orders (customer_id, total, status) VALUES
	(1, 19.99, 'paid'),
	(1, 5.00, 'pending'),
	(2, 99.00, 'paid');
